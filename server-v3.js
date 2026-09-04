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

const SESSION = 'comunicados-alunos-v3';
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
  client: null, connected: false, ready: false, status: 'iniciando',
  qr: null, lastError: null, starting: false, syncing: false
};

const digits = v => String(v ?? '').replace(/\D/g, '');
function normalizeBrazilPhone(value) {
  let n = digits(value);
  if (!n) return null;
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('55')) n = n.slice(2);
  if (n.length === 10) {
    const ddd = n.slice(0, 2), local = n.slice(2);
    if (/^[6-9]/.test(local)) n = ddd + '9' + local;
  }
  if (n.length !== 11) return null;
  const ddd = Number(n.slice(0, 2));
  if (ddd < 11 || ddd > 99 || !/^9/.test(n.slice(2))) return null;
  return '55' + n;
}

function serializeWid(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v._serialized) return String(v._serialized);
  if (v.id && v.id !== v) return serializeWid(v.id);
  if (v.user && v.server) return `${v.user}@${v.server}`;
  return '';
}

function timeout(promise, ms, label) {
  let id;
  const timerPromise = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error(`${label} não respondeu em ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timerPromise]).finally(() => clearTimeout(id));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function killOrphanChromium() {
  try { await execFileAsync('pkill', ['-f', sessionDir]); await sleep(700); } catch (_) {}
  try {
    if (!fs.existsSync(sessionDir)) return;
    const stack = [sessionDir];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (['SingletonLock','SingletonCookie','SingletonSocket'].includes(e.name)) {
          try { fs.rmSync(full, { force: true, recursive: true }); } catch (_) {}
        }
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
  state.contacts = valid; state.contactSource = source; state.queue = [];
  state.sent = 0; state.failed = 0; state.log = [];
  state.running = false; state.paused = false; state.cancelled = false;
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

async function probeOperational(client) {
  if (!client?.page || typeof client.page.evaluate !== 'function') return false;
  try {
    return await timeout(client.page.evaluate(async () => {
      if (!globalThis.WPP?.chat?.list) return false;
      const rows = await globalThis.WPP.chat.list({ count: 1 });
      return Array.isArray(rows);
    }), 7000, 'Teste de prontidão');
  } catch (_) {
    return false;
  }
}

async function waitUntilOperational(client, maxMs = 70000) {
  whatsapp.syncing = true;
  whatsapp.ready = false;
  whatsapp.status = 'sincronizando';
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await probeOperational(client)) {
      whatsapp.connected = true;
      whatsapp.ready = true;
      whatsapp.syncing = false;
      whatsapp.status = 'READY';
      whatsapp.lastError = null;
      return true;
    }
    await sleep(3000);
  }
  whatsapp.syncing = false;
  whatsapp.ready = false;
  whatsapp.status = 'sincronizando';
  whatsapp.lastError = 'WhatsApp conectado, mas ainda sincronizando as conversas. Aguarde e tente novamente.';
  return false;
}

async function startWhatsApp({ forceClean = false } = {}) {
  if (whatsapp.starting || whatsapp.client) return;
  whatsapp.starting = true;
  whatsapp.status = 'conectando';
  whatsapp.lastError = null;
  whatsapp.qr = null;
  whatsapp.connected = false;
  whatsapp.ready = false;

  try {
    if (forceClean) await killOrphanChromium();

    const client = await timeout(wppconnect.create({
      session: SESSION,
      folderNameToken: tokenDir,
      waitForLogin: true,
      headless: true,
      logQR: false,
      autoClose: 0,
      catchQR: base64Qr => {
        const q = String(base64Qr || '');
        whatsapp.qr = q.startsWith('data:image') ? q : `data:image/png;base64,${q}`;
        whatsapp.status = 'aguardando_qr';
        whatsapp.connected = false;
        whatsapp.ready = false;
      },
      statusFind: s => {
        whatsapp.status = s || whatsapp.status;
        if (['isLogged','inChat','qrReadSuccess'].includes(s)) {
          whatsapp.connected = true;
          whatsapp.ready = false;
          whatsapp.qr = null;
        }
        if (['notLogged','qrReadFail','disconnectedMobile','deleteToken','browserClose','serverClose','autocloseCalled'].includes(s)) {
          whatsapp.connected = false;
          whatsapp.ready = false;
        }
      },
      puppeteerOptions: {
        executablePath: process.env.CHROME_PATH || undefined,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--no-zygote']
      }
    }), 90000, 'Inicialização do WhatsApp');

    whatsapp.client = client;
    whatsapp.connected = true;
    whatsapp.ready = false;
    whatsapp.qr = null;
    whatsapp.status = 'sincronizando';

    if (typeof client.start === 'function') {
      try { await timeout(client.start(), 25000, 'client.start'); } catch (e) { console.warn('[WHATSAPP] client.start:', e.message); }
    }

    if (typeof client.onStateChange === 'function') {
      client.onStateChange(s => {
        if (['DISCONNECTED','UNPAIRED','UNPAIRED_IDLE','CONFLICT'].includes(s)) {
          whatsapp.connected = false;
          whatsapp.ready = false;
          whatsapp.status = s;
        } else if (['CONNECTED','READY'].includes(s)) {
          whatsapp.connected = true;
          if (!whatsapp.ready) whatsapp.status = 'sincronizando';
        }
      });
    }

    await waitUntilOperational(client);
  } catch (error) {
    whatsapp.client = null;
    whatsapp.connected = false;
    whatsapp.ready = false;
    whatsapp.status = 'erro';
    whatsapp.lastError = error.message;
    console.error('[WHATSAPP]', error);
  } finally {
    whatsapp.starting = false;
  }
}

async function closeWhatsApp({ logout = false } = {}) {
  const client = whatsapp.client;
  whatsapp.client = null; whatsapp.connected = false; whatsapp.ready = false;
  whatsapp.qr = null; whatsapp.lastError = null; whatsapp.syncing = false;
  if (client) {
    if (logout && typeof client.logout === 'function') { try { await timeout(client.logout(), 8000, 'logout'); } catch (_) {} }
    if (typeof client.close === 'function') { try { await timeout(client.close(), 8000, 'close'); } catch (_) {} }
  }
  await killOrphanChromium();
}

function clearTokens() {
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.mkdirSync(tokenDir, { recursive: true });
}

async function listGroups() {
  const client = whatsapp.client;
  if (!client) throw new Error('WhatsApp não está conectado.');
  if (!whatsapp.ready) {
    const ok = await probeOperational(client);
    if (!ok) throw new Error('WhatsApp ainda está sincronizando as conversas. Aguarde alguns segundos.');
    whatsapp.connected = true; whatsapp.ready = true; whatsapp.status = 'READY'; whatsapp.lastError = null;
  }

  if (client.page && typeof client.page.evaluate === 'function') {
    const groups = await timeout(client.page.evaluate(async () => {
      if (!globalThis.WPP?.group?.getAllGroups) throw new Error('API de grupos ainda não carregou');
      const rows = await globalThis.WPP.group.getAllGroups();
      return (rows || []).map(g => ({
        id: g?.id?._serialized || g?.id?.toString?.() || String(g?.id || ''),
        name: g?.subject || g?.name || 'Grupo sem nome',
        participants: Array.isArray(g?.participants) ? g.participants.length : null
      }));
    }), 20000, 'Carregamento dos grupos');
    const clean = (groups || []).filter(g => String(g.id).endsWith('@g.us'));
    if (clean.length) return clean.sort((a,b) => String(a.name).localeCompare(String(b.name), 'pt-BR'));
  }

  if (typeof client.listChats === 'function') {
    const raw = await timeout(client.listChats({ onlyGroups: true }), 20000, 'listChats');
    const clean = (Array.isArray(raw) ? raw : []).map(g => ({
      id: serializeWid(g?.id || g?.groupMetadata?.id),
      name: g?.subject || g?.name || g?.formattedTitle || g?.groupMetadata?.subject || 'Grupo sem nome',
      participants: Array.isArray(g?.groupMetadata?.participants) ? g.groupMetadata.participants.length : null
    })).filter(g => g.id.endsWith('@g.us'));
    if (clean.length) return clean;
  }

  return [];
}

async function getParticipants(groupId) {
  const client = whatsapp.client;
  if (!client || !whatsapp.ready) throw new Error('WhatsApp ainda não está pronto.');

  if (client.page && typeof client.page.evaluate === 'function') {
    try {
      return await timeout(client.page.evaluate(async gid => {
        if (!globalThis.WPP?.group?.getParticipants) throw new Error('API de participantes ainda não carregou');
        const rows = await globalThis.WPP.group.getParticipants(gid);
        return (rows || []).map(p => p?.id?._serialized || p?.id?.toString?.() || String(p?.id || ''));
      }, groupId), 20000, 'Participantes do grupo');
    } catch (_) {}
  }

  if (typeof client.getGroupMembersIds === 'function') {
    return timeout(client.getGroupMembersIds(groupId), 20000, 'getGroupMembersIds');
  }
  throw new Error('Não foi possível ler os participantes desse grupo.');
}

async function sendWhatsAppText(phone, message) {
  if (!whatsapp.client || !whatsapp.ready) throw new Error('WhatsApp ainda não está pronto.');
  return timeout(whatsapp.client.sendText(`${phone}@c.us`, message), 20000, 'sendText');
}

async function runBatch() {
  if (!state.running || state.paused || state.cancelled) return;
  const pending = state.queue.filter(x => x.status === 'pending').slice(0, state.batchSize);
  if (!pending.length) { state.running = false; state.nextBatchAt = null; addLog('-', 'done', 'Fila concluída.'); return; }

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
  if (!state.queue.some(x => x.status === 'pending')) { state.running = false; state.nextBatchAt = null; addLog('-', 'done', 'Fila concluída.'); return; }
  const delay = state.intervalMinutes * 60000;
  state.nextBatchAt = new Date(Date.now() + delay).toISOString();
  clearTimeout(timer);
  timer = setTimeout(runBatch, delay);
}

app.get('/api/status', (_req, res) => res.json(publicState()));

app.post('/api/whatsapp/reconnect', async (_req, res) => {
  if (state.running) return res.status(409).json({ error: 'Pause ou cancele o envio antes de reconectar.' });
  if (whatsapp.starting) return res.status(409).json({ error: 'A conexão já está sendo iniciada.' });
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
    res.status(503).json({ error: `Não consegui carregar os grupos: ${error.message}` });
  }
});

app.post('/api/groups/import', async (req, res) => {
  try {
    const groupId = String(req.body.groupId || '').trim();
    if (!groupId.endsWith('@g.us')) return res.status(400).json({ error: 'Selecione um grupo válido.' });
    const members = await getParticipants(groupId);
    const seen = new Set(), valid = [];
    let invalid = 0, duplicates = 0;
    for (const member of members || []) {
      const raw = serializeWid(member) || String(member || '');
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
  if (!whatsapp.client || !whatsapp.ready) return res.status(400).json({ error: 'Aguarde o WhatsApp ficar pronto para uso.' });
  if (!state.contacts.length) return res.status(400).json({ error: 'Importe contatos primeiro.' });
  if (!message) return res.status(400).json({ error: 'Escreva a mensagem.' });
  if (state.running) return res.status(409).json({ error: 'Já existe um envio em andamento.' });

  state.message = message; state.batchSize = batchSize; state.intervalMinutes = intervalMinutes;
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
app.listen(port, '0.0.0.0', () => console.log(`Comunicados Alunos v3 em http://0.0.0.0:${port}`));
startWhatsApp({ forceClean: true });
