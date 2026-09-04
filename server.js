require('dotenv').config();
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const wppconnect = require('@wppconnect-team/wppconnect');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  contacts: [], queue: [], running: false, paused: false, cancelled: false,
  batchSize: 5, intervalMinutes: 10, message: '', sent: 0, failed: 0,
  startedAt: null, nextBatchAt: null, log: [], contactSource: null
};
let timer = null;

const whatsapp = { client: null, connected: false, status: 'iniciando', qr: null, lastError: null };
const tokenDir = process.env.WPP_TOKEN_DIR || path.join(process.cwd(), 'tokens');
fs.mkdirSync(tokenDir, { recursive: true });

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
    whatsapp: { connected: whatsapp.connected, status: whatsapp.status, qr: whatsapp.qr, lastError: whatsapp.lastError }
  };
}

function idToString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value._serialized || value.id?._serialized || value.id || (value.user && value.server ? `${value.user}@${value.server}` : '') || '';
}

function groupIdFromChat(chat) {
  const candidates = [
    chat?.id,
    chat?.groupMetadata?.id,
    chat?.contact?.id,
    chat?.wid,
    chat?.chatId
  ];
  for (const c of candidates) {
    const id = idToString(c);
    if (id.endsWith('@g.us')) return id;
  }
  return '';
}

function groupNameFromChat(chat) {
  return chat?.name || chat?.formattedTitle || chat?.title || chat?.groupMetadata?.subject || chat?.contact?.formattedName || 'Grupo sem nome';
}

async function listGroupsRobust(client) {
  let raw = [];
  if (typeof client.getAllGroups === 'function') {
    try { raw = await client.getAllGroups(); } catch (e) { console.warn('getAllGroups falhou:', e.message); }
  }
  let groups = Array.isArray(raw) ? raw : [];

  // Fallback importante: algumas versões retornam grupos só pela lista de chats.
  if (!groups.length && typeof client.getAllChats === 'function') {
    try {
      const chats = await client.getAllChats();
      groups = (Array.isArray(chats) ? chats : []).filter(c => {
        const id = groupIdFromChat(c);
        return !!id || c?.isGroup === true || c?.contact?.isGroup === true;
      });
    } catch (e) { console.warn('getAllChats falhou:', e.message); }
  }

  const map = new Map();
  for (const g of groups) {
    const id = groupIdFromChat(g);
    if (!id) continue;
    const participants = Array.isArray(g?.groupMetadata?.participants) ? g.groupMetadata.participants.length : null;
    map.set(id, { id, name: groupNameFromChat(g), participants });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

async function startWhatsApp() {
  if (whatsapp.client || whatsapp.status === 'conectando') return;
  whatsapp.status = 'conectando';
  whatsapp.lastError = null;
  try {
    const client = await wppconnect.create({
      session: 'comunicados-alunos',
      folderNameToken: tokenDir,
      headless: true,
      logQR: false,
      autoClose: 0,
      catchQR: (base64Qr) => {
        whatsapp.qr = base64Qr;
        whatsapp.connected = false;
        whatsapp.status = 'aguardando_qr';
      },
      statusFind: (statusSession) => {
        whatsapp.status = statusSession || whatsapp.status;
        if (['isLogged', 'inChat'].includes(statusSession)) {
          whatsapp.connected = true;
          whatsapp.qr = null;
        }
        if (['notLogged','qrReadFail','disconnectedMobile','deleteToken','browserClose','serverClose','autocloseCalled'].includes(statusSession)) whatsapp.connected = false;
      },
      puppeteerOptions: {
        executablePath: process.env.CHROME_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      }
    });
    whatsapp.client = client;
    whatsapp.connected = true;
    whatsapp.status = 'conectado';
    whatsapp.qr = null;
    if (typeof client.onStateChange === 'function') client.onStateChange((status) => {
      whatsapp.status = status || whatsapp.status;
      if (status === 'CONNECTED') whatsapp.connected = true;
      if (['UNPAIRED','UNPAIRED_IDLE','CONFLICT'].includes(status)) whatsapp.connected = false;
    });
  } catch (error) {
    whatsapp.client = null;
    whatsapp.connected = false;
    whatsapp.status = 'erro';
    whatsapp.lastError = error.message;
    console.error('Erro ao iniciar WhatsApp:', error);
    setTimeout(startWhatsApp, 15000);
  }
}

async function closeWhatsAppClient({ logout = false } = {}) {
  const client = whatsapp.client;
  whatsapp.client = null;
  whatsapp.connected = false;
  whatsapp.qr = null;
  whatsapp.lastError = null;
  if (!client) return;
  if (logout && typeof client.logout === 'function') {
    try { await client.logout(); } catch (e) { console.warn('Logout falhou:', e.message); }
  }
  if (typeof client.close === 'function') {
    try { await client.close(); } catch (e) { console.warn('Fechamento falhou:', e.message); }
  }
}

function clearWhatsAppTokens() {
  fs.rmSync(tokenDir, { recursive: true, force: true });
  fs.mkdirSync(tokenDir, { recursive: true });
}

async function sendWhatsAppText(phone, message) {
  if (!whatsapp.client || !whatsapp.connected) throw new Error('WhatsApp não está conectado. Leia o QR Code primeiro.');
  return whatsapp.client.sendText(`${phone}@c.us`, message);
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
  const delay = state.intervalMinutes * 60 * 1000;
  state.nextBatchAt = new Date(Date.now() + delay).toISOString();
  clearTimeout(timer);
  timer = setTimeout(runBatch, delay);
}

app.get('/api/status', (_req, res) => res.json(publicState()));

app.post('/api/whatsapp/reconnect', async (_req, res) => {
  if (state.running) return res.status(409).json({ error: 'Pause ou cancele o envio antes de reconectar o WhatsApp.' });
  await closeWhatsAppClient({ logout: false });
  whatsapp.status = 'reiniciando';
  setTimeout(startWhatsApp, 500);
  res.json({ ok: true, state: publicState() });
});

app.post('/api/whatsapp/disconnect', async (_req, res) => {
  if (state.running) return res.status(409).json({ error: 'Pause ou cancele o envio antes de desconectar o WhatsApp.' });
  await closeWhatsAppClient({ logout: false });
  whatsapp.status = 'desconectado';
  res.json({ ok: true, state: publicState() });
});

app.post('/api/whatsapp/change-number', async (_req, res) => {
  if (state.running) return res.status(409).json({ error: 'Pause ou cancele o envio antes de trocar o número.' });
  try {
    whatsapp.status = 'trocando_numero';
    await closeWhatsAppClient({ logout: true });
    clearWhatsAppTokens();
    whatsapp.status = 'gerando_novo_qr';
    setTimeout(startWhatsApp, 800);
    res.json({ ok: true, state: publicState() });
  } catch (error) {
    whatsapp.status = 'erro'; whatsapp.lastError = error.message;
    res.status(500).json({ error: `Não consegui trocar o número: ${error.message}` });
  }
});

app.get('/api/groups', async (_req, res) => {
  try {
    if (!whatsapp.client || !whatsapp.connected) return res.status(400).json({ error: 'Conecte o WhatsApp primeiro.' });
    const groups = await listGroupsRobust(whatsapp.client);
    console.log(`Grupos encontrados: ${groups.length}`);
    res.json({ ok: true, groups });
  } catch (error) {
    console.error('Erro ao listar grupos:', error);
    res.status(500).json({ error: `Não consegui listar os grupos: ${error.message}` });
  }
});

app.post('/api/groups/import', async (req, res) => {
  try {
    if (!whatsapp.client || !whatsapp.connected) return res.status(400).json({ error: 'Conecte o WhatsApp primeiro.' });
    const groupId = String(req.body.groupId || '').trim();
    if (!groupId.endsWith('@g.us')) return res.status(400).json({ error: 'Selecione um grupo válido.' });

    let members = [];
    if (typeof whatsapp.client.getGroupMembersIds === 'function') members = await whatsapp.client.getGroupMembersIds(groupId);
    else if (typeof whatsapp.client.getGroupMembers === 'function') members = await whatsapp.client.getGroupMembers(groupId);
    else throw new Error('Esta versão do WPPConnect não expõe leitura de participantes.');

    const seen = new Set(), valid = [];
    let invalid = 0, duplicates = 0;
    for (const member of members || []) {
      const raw = idToString(member?.id || member) || member?.user || '';
      const phone = normalizeBrazilPhone(raw);
      if (!phone) { invalid++; continue; }
      if (seen.has(phone)) { duplicates++; continue; }
      seen.add(phone); valid.push(phone);
    }
    if (!valid.length) return res.status(400).json({ error: 'Não encontrei telefones brasileiros válidos nesse grupo.' });
    resetContacts(valid, { type: 'group', groupId });
    res.json({ ok: true, valid: valid.length, invalid, duplicates, preview: valid.slice(0, 8), state: publicState() });
  } catch (error) {
    console.error('Erro ao importar participantes:', error);
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
    const seen = new Set(), valid = []; let invalid = 0, duplicates = 0;
    for (const row of rows) {
      const phone = normalizeBrazilPhone(row[phoneColumn]);
      if (!phone) { invalid++; continue; }
      if (seen.has(phone)) { duplicates++; continue; }
      seen.add(phone); valid.push(phone);
    }
    resetContacts(valid, { type: 'spreadsheet', file: req.file.originalname });
    res.json({ ok: true, phoneColumn, totalRows: rows.length, valid: valid.length, invalid, duplicates, preview: valid.slice(0, 8) });
  } catch (error) { res.status(400).json({ error: `Não foi possível ler a planilha: ${error.message}` }); }
});

app.post('/api/start', (req, res) => {
  const message = String(req.body.message || '').trim();
  const batchSize = Math.max(1, Math.min(20, Number(req.body.batchSize) || 5));
  const intervalMinutes = Math.max(1, Math.min(1440, Number(req.body.intervalMinutes) || 10));
  if (!whatsapp.connected) return res.status(400).json({ error: 'Conecte o WhatsApp pelo QR Code antes de iniciar.' });
  if (!state.contacts.length) return res.status(400).json({ error: 'Importe contatos primeiro.' });
  if (!message) return res.status(400).json({ error: 'Escreva a mensagem.' });
  if (state.running) return res.status(409).json({ error: 'Já existe um envio em andamento.' });
  state.message = message; state.batchSize = batchSize; state.intervalMinutes = intervalMinutes;
  state.queue = state.contacts.map(phone => ({ phone, status: 'pending' }));
  state.sent = 0; state.failed = 0; state.log = []; state.running = true; state.paused = false; state.cancelled = false;
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
  state.cancelled = true; state.running = false; state.paused = false; clearTimeout(timer); state.nextBatchAt = null;
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
startWhatsApp();
