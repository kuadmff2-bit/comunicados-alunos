require('dotenv').config();
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const wppconnect = require('@wppconnect-team/wppconnect');

const execFileAsync = promisify(execFile);
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SESSION = 'comunicados-alunos';
const tokenDir = process.env.WPP_TOKEN_DIR || path.join(process.cwd(), 'tokens');
const sessionDir = path.join(tokenDir, SESSION);
fs.mkdirSync(tokenDir, { recursive: true });

const state = {
  contacts: [], queue: [], running: false, paused: false, cancelled: false,
  batchSize: 5, intervalMinutes: 10, message: '', sent: 0, failed: 0,
  startedAt: null, nextBatchAt: null, log: [], contactSource: null
};
let timer = null;

const whatsapp = {
  client: null,
  connected: false,
  ready: false,
  status: 'iniciando',
  qr: null,
  lastError: null,
  starting: false,
  stoppedByUser: false
};

function digits(value) { return String(value ?? '').replace(/\D/g, ''); }
function normalizeBrazilPhone(value) {
  let n = digits(value);
  if (!n) return null;
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('55')) n = n.slice(2);
  if (n.length === 10) {
    const ddd = n.slice(0, 2);
    const local = n.slice(2);
    if (/^[6-9]/.test(local)) n = ddd + '9' + local;
  }
  if (n.length !== 11) return null;
  const ddd = Number(n.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  if (!/^9/.test(n.slice(2))) return null;
  return '55' + n;
}

function serializeWid(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value._serialized) return String(value._serialized);
  if (value.id && value.id !== value) {
    const nested = serializeWid(value.id);
    if (nested) return nested;
  }
  if (value.user && value.server) return `${value.user}@${value.server}`;
  return '';
}

function groupIdFromChat(chat) {
  for (const candidate of [chat?.id, chat?.groupMetadata?.id, chat?.contact?.id, chat?.wid, chat?.chatId]) {
    const id = serializeWid(candidate);
    if (id.endsWith('@g.us')) return id;
  }
  return '';
}

function compactGroups(raw) {
  const rows = Array.isArray(raw) ? raw : Object.values(raw || {});
  const map = new Map();
  for (const g of rows) {
    const id = groupIdFromChat(g);
    if (!id) continue;
    const name = g?.subject || g?.name || g?.formattedTitle || g?.title || g?.groupMetadata?.subject || 'Grupo sem nome';
    const participants = Number.isFinite(Number(g?.size)) ? Number(g.size)
      : Array.isArray(g?.participants) ? g.participants.length
      : Array.isArray(g?.groupMetadata?.participants) ? g.groupMetadata.participants.length
      : null;
    map.set(id, { id, name, participants });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

function timeout(promise, ms, label) {
  let id;
  const t = new Promise((_, reject) => { id = setTimeout(() => reject(new Error(`${label} não respondeu em ${Math.round(ms / 1000)}s`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(id));
}

async function killOrphanChromium() {
  try {
    await execFileAsync('pkill', ['-f', sessionDir]);
    await new Promise(r => setTimeout(r, 600));
  } catch (_) {}
  try {
    if (fs.existsSync(sessionDir)) {
      for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        fs.rmSync(path.join(sessionDir, name), { force: true, recursive: true });
      }
    }
  } catch (_) {}
}

function detectPhoneColumn(rows) {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0] || {});
  const preferred = keys.find(k => /^(telefone|celular|whatsapp|fone|phone|numero|n[uú]mero)$/i.test(String(k).trim()));
  if (preferred) return preferred;
  let best = null, bestScore = 0;
  for (const key of keys) {
    let score = 0;
    for (const row of rows.slice(0, 30)) if (normalizeBrazilPhone(row[key])) score++;
    if (score > bestScore) { bestScore = score; best = key; }
  }
  return bestScore ? best : null;
}

function resetContacts(valid, source) {
  state.contacts = valid;
  state.contactSource = source;
  state.queue = [];
  state.sent = 0;
  state.failed = 0;
  state.log = [];
  state.running = false;
  state.paused = false;
  state.cancelled = false;
  clearTimeout(timer);
}

function addLog(phone, status, detail) {
  state.log.push({ time: new Date().toISOString(), phone, status, detail });
  if (state.log.length > 1000) state.log = state.log.slice(-1000);
}

function publicState() {
  return {
    contacts: state.contacts.length,
    contactSource: state.contactSource,
    queued: state.queue.filter(x => x.status === 'pending').length,
    sent: state.sent,
    failed: state.failed,
    running: state.running,
    paused: state.paused,
    cancelled: state.cancelled,
    batchSize: state.batchSize,
    intervalMinutes: state.intervalMinutes,
    startedAt: state.startedAt,
    nextBatchAt: state.nextBatchAt,
    log: state.log.slice(-100).reverse(),
    whatsapp: {
      connected: whatsapp.connected,
      ready: whatsapp.ready,
      status: whatsapp.status,
      qr: whatsapp.qr,
      lastError: whatsapp.lastError
    }
  };
}

async function startWhatsApp({ forceClean = false } = {}) {
  if (whatsapp.starting) return;
  if (whatsapp.client && whatsapp.connected) return;

  whatsapp.starting = true;
  whatsapp.stoppedByUser = false;
  whatsapp.status = 'conectando';
  whatsapp.lastError = null;
  whatsapp.qr = null;

  try {
    if (forceClean || !whatsapp.client) await killOrphanChromium();

    const client = await wppconnect.create({
      session: SESSION,
      folderNameToken: tokenDir,
      headless: true,
      logQR: false,
      autoClose: 0,
      catchQR: (base64Qr) => {
        whatsapp.qr = String(base64Qr || '').startsWith('data:image') ? base64Qr : `data:image/png;base64,${base64Qr}`;
        whatsapp.connected = false;
        whatsapp.ready = false;
        whatsapp.status = 'aguardando_qr';
      },
      statusFind: (statusSession) => {
        whatsapp.status = statusSession || whatsapp.status;
        if (['isLogged', 'inChat', 'qrReadSuccess'].includes(statusSession)) {
          whatsapp.connected = true;
          whatsapp.qr = null;
        }
        if (['notLogged','qrReadFail','disconnectedMobile','deleteToken','browserClose','serverClose','autocloseCalled'].includes(statusSession)) {
          whatsapp.connected = false;
          whatsapp.ready = false;
        }
      },
      puppeteerOptions: {
        executablePath: process.env.CHROME_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote']
      }
    });

    whatsapp.client = client;
    whatsapp.connected = true;
    whatsapp.ready = true;
    whatsapp.status = 'READY';
    whatsapp.qr = null;

    if (typeof client.onStateChange === 'function') {
      client.onStateChange((s) => {
        whatsapp.status = s || whatsapp.status;
        if (['CONNECTED', 'READY'].includes(s)) {
          whatsapp.connected = true;
          whatsapp.ready = true;
        }
        if (['DISCONNECTED','UNPAIRED','UNPAIRED_IDLE','CONFLICT'].includes(s)) {
          whatsapp.connected = false;
          whatsapp.ready = false;
        }
      });
    }
  } catch (error) {
    whatsapp.client = null;
    whatsapp.connected = false;
    whatsapp.ready = false;
    whatsapp.status = 'erro';
    whatsapp.lastError = error.message;
    console.error('[WHATSAPP] Falha ao iniciar:', error);
  } finally {
    whatsapp.starting = false;
  }
}

async function closeWhatsApp({ logout = false } = {}) {
  const client = whatsapp.client;
  whatsapp.client = null;
  whatsapp.connected = false;
  whatsapp.ready = false;
  whatsapp.qr = null;
  whatsapp.lastError = null;
  whatsapp.stoppedByUser = true;

  if (client) {
    if (logout && typeof client.logout === 'function') {
      try { await timeout(client.logout(), 8000, 'logout'); } catch (_) {}
    }
    if (typeof client.close === 'function') {
      try { await timeout(client.close(), 8000, 'close'); } catch (_) {}
    }
  }
  await killOrphanChromium();
}

function clearTokens() {
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(tokenDir, { recursive: true });
}

async function listGroups() {
  if (!whatsapp.client || !whatsapp.connected) throw new Error('WhatsApp não está conectado.');
  const client = whatsapp.client;
  const errors = [];

  if (typeof client.listChats === 'function') {
    try {
      const raw = await timeout(client.listChats({ onlyGroups: true }), 12000, 'listChats');
      const groups = compactGroups(raw);
      if (groups.length) return groups;
    } catch (e) { errors.push(e.message); }
  }

  if (typeof client.getAllGroups === 'function') {
    try {
      const raw = await timeout(client.getAllGroups(), 10000, 'getAllGroups');
      const groups = compactGroups(raw);
      if (groups.length) return groups;
    } catch (e) { errors.push(e.message); }
  }

  if (typeof client.getAllChats === 'function') {
    try {
      const raw = await timeout(client.getAllChats(), 10000, 'getAllChats');
      const groups = compactGroups(raw);
      if (groups.length) return groups;
    } catch (e) { errors.push(e.message); }
  }

  if (errors.length) throw new Error(errors.join(' | '));
  return [];
}

async function sendWhatsAppText(phone, message) {
  if (!whatsapp.client || !whatsapp.connected) throw new Error('WhatsApp não está conectado.');
  return timeout(whatsapp.client.sendText(`${phone}@c.us`, message), 20000, 'sendText');
}

async function runBatch() {
  if (!state.running || state.paused || state.cancelled) return;
  const pending = state.queue.filter(x => x.status === 'pending').slice(0, state.batchSize);
  if (!pending.length) {
    state.running = false; state.nextBatchAt = null; addLog('-', 'done', 'Fila concluída.'); return;
  }

  for (const item of pending) {
    if (state.paused || state.cancelled) break;
    item.status = 'sending';
    try {
      await sendWhatsAppText(item.phone, state.message);
      item.status = 'sent'; item.sentAt = new Date().toISOString(); state.sent++;
      addLog(item.phone, 'sent', 'Enviado.');
    } catch (error) {
      item.status = 'failed'; item.error = error.message; state.failed++;
      addLog(item.phone, 'failed', item.error);
    }
  }

  if (state.cancelled || state.paused || !state.running) return;
  if (!state.queue.some(x => x.status === 'pending')) {
    state.running = false; state.nextBatchAt = null; addLog('-', 'done', 'Fila concluída.'); return;
  }

  const delay = state.intervalMinutes * 60 * 1000;
  state.nextBatchAt = new Date(Date.now() + delay).toISOString();
  clearTimeout(timer);
  timer = setTimeout(runBatch, delay);
}

app.get('/api/status', (_req, res) => res.json(publicState()));

app.post('/api/whatsapp/reconnect', async (_req, res) => {
  if (state.running) return res.status(409).json({ error: 'Pause ou cancele o envio antes de reconectar.' });
  if (whatsapp.starting) return res.status(409).json({ error: 'A conexão já está sendo iniciada. Aguarde alguns segundos.' });
  await closeWhatsApp({ logout: false });
  whatsapp.status = 'reiniciando';
  setTimeout(() => startWhatsApp({ forceClean: true }), 700);
  res.json({ ok: true, state: publicState() });
});

app.post('/api/whatsapp/disconnect', async (_req, res) => {
  if (state.running) return res.status(409).json({ error: 'Pause ou cancele o envio antes de desconectar.' });
  await closeWhatsApp({ logout: false });
  whatsapp.status = 'desconectado';
  res.json({ ok: true, state: publicState() });
});

app.post('/api/whatsapp/change-number', async (_req, res) => {
  if (state.running) return res.status(409).json({ error: 'Pause ou cancele o envio antes de trocar o número.' });
  await closeWhatsApp({ logout: true });
  clearTokens();
  whatsapp.status = 'gerando_novo_qr';
  setTimeout(() => startWhatsApp({ forceClean: true }), 700);
  res.json({ ok: true, state: publicState() });
});

app.get('/api/groups', async (_req, res) => {
  try {
    const groups = await listGroups();
    res.json({ ok: true, groups });
  } catch (error) {
    res.status(504).json({ error: `Não consegui carregar os grupos: ${error.message}` });
  }
});

app.post('/api/groups/import', async (req, res) => {
  try {
    if (!whatsapp.client || !whatsapp.connected) return res.status(400).json({ error: 'Conecte o WhatsApp primeiro.' });
    const groupId = String(req.body.groupId || '').trim();
    if (!groupId.endsWith('@g.us')) return res.status(400).json({ error: 'Selecione um grupo válido.' });

    let members = [];
    if (typeof whatsapp.client.getGroupMembersIds === 'function') {
      members = await timeout(whatsapp.client.getGroupMembersIds(groupId), 12000, 'getGroupMembersIds');
    } else if (typeof whatsapp.client.getChatById === 'function') {
      const chat = await timeout(whatsapp.client.getChatById(groupId), 12000, 'getChatById');
      members = chat?.groupMetadata?.participants || [];
    } else {
      throw new Error('Leitura de participantes indisponível nesta versão.');
    }

    const seen = new Set(), valid = [];
    let invalid = 0, duplicates = 0;
    for (const member of members || []) {
      const raw = serializeWid(member?.id || member) || member?.user || '';
      const phone = normalizeBrazilPhone(raw);
      if (!phone) { invalid++; continue; }
      if (seen.has(phone)) { duplicates++; continue; }
      seen.add(phone); valid.push(phone);
    }

    if (!valid.length) return res.status(400).json({ error: 'Não encontrei telefones brasileiros válidos nesse grupo.' });
    resetContacts(valid, { type: 'group', groupId });
    res.json({ ok: true, valid: valid.length, invalid, duplicates, preview: valid.slice(0, 8), state: publicState() });
  } catch (error) {
    res.status(500).json({ error: `Não consegui importar os participantes: ${error.message}` });
  }
});

app.post('/api/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecione uma planilha.' });
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'A planilha está vazia.' });
    const phoneColumn = detectPhoneColumn(rows);
    if (!phoneColumn) return res.status(400).json({ error: 'Não consegui identificar a coluna de telefone.' });

    const seen = new Set(), valid = [];
    let invalid = 0, duplicates = 0;
    for (const row of rows) {
      const phone = normalizeBrazilPhone(row[phoneColumn]);
      if (!phone) { invalid++; continue; }
      if (seen.has(phone)) { duplicates++; continue; }
      seen.add(phone); valid.push(phone);
    }

    resetContacts(valid, { type: 'spreadsheet', file: req.file.originalname });
    res.json({ ok: true, phoneColumn, totalRows: rows.length, valid: valid.length, invalid, duplicates, preview: valid.slice(0, 8) });
  } catch (error) {
    res.status(400).json({ error: `Não foi possível ler a planilha: ${error.message}` });
  }
});

app.post('/api/start', (req, res) => {
  const message = String(req.body.message || '').trim();
  const batchSize = Math.max(1, Math.min(20, Number(req.body.batchSize) || 5));
  const intervalMinutes = Math.max(1, Math.min(1440, Number(req.body.intervalMinutes) || 10));
  if (!whatsapp.connected) return res.status(400).json({ error: 'Conecte o WhatsApp antes de iniciar.' });
  if (!state.contacts.length) return res.status(400).json({ error: 'Importe contatos primeiro.' });
  if (!message) return res.status(400).json({ error: 'Escreva a mensagem.' });
  if (state.running) return res.status(409).json({ error: 'Já existe um envio em andamento.' });

  state.message = message;
  state.batchSize = batchSize;
  state.intervalMinutes = intervalMinutes;
  state.queue = state.contacts.map(phone => ({ phone, status: 'pending' }));
  state.sent = 0; state.failed = 0; state.log = [];
  state.running = true; state.paused = false; state.cancelled = false;
  state.startedAt = new Date().toISOString(); state.nextBatchAt = null;
  setImmediate(runBatch);
  res.json({ ok: true, state: publicState() });
});

app.post('/api/pause', (_req, res) => {
  if (!state.running) return res.status(400).json({ error: 'Não há envio em andamento.' });
  state.paused = true; clearTimeout(timer); state.nextBatchAt = null;
  res.json({ ok: true, state: publicState() });
});

app.post('/api/resume', (_req, res) => {
  if (!state.running || !state.paused) return res.status(400).json({ error: 'Não há envio pausado.' });
  state.paused = false; setImmediate(runBatch);
  res.json({ ok: true, state: publicState() });
});

app.post('/api/cancel', (_req, res) => {
  state.cancelled = true; state.running = false; state.paused = false;
  clearTimeout(timer); state.nextBatchAt = null;
  for (const item of state.queue) if (item.status === 'pending') item.status = 'cancelled';
  addLog('-', 'cancelled', 'Fila cancelada pelo operador.');
  res.json({ ok: true, state: publicState() });
});

app.get('/api/export', (_req, res) => {
  const rows = state.queue.map(item => ({ telefone: item.phone, status: item.status, enviado_em: item.sentAt || '', erro: item.error || '' }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ telefone: '', status: 'sem dados' }]);
  XLSX.utils.book_append_sheet(wb, ws, 'Relatorio');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="relatorio-comunicados.xlsx"');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log(`Comunicados Alunos em http://0.0.0.0:${port}`));
startWhatsApp({ forceClean: true });
