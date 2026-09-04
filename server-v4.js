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

// Reaproveita a sessão v3 já autenticada, mas com backend novo.
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
let cachedGroups = new Map();

const whatsapp = {
  client: null, connected: false, ready: false, status: 'iniciando',
  qr: null, lastError: null, starting: false
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
function timeout(promise, ms, label) {
  let id;
  const t = new Promise((_, reject) => { id = setTimeout(() => reject(new Error(`${label} não respondeu em ${Math.round(ms / 1000)}s`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(id));
}

async function killOrphanChromium() {
  try { await execFileAsync('pkill', ['-f', sessionDir]); await sleep(600); } catch (_) {}
  try {
    if (!fs.existsSync(sessionDir)) return;
    const stack = [sessionDir];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(e.name)) {
          try { fs.rmSync(full, { force: true, recursive: true }); } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

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

function detectPhoneColumn(rows) {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0] || {});
  const preferred = keys.find(k => /^(telefone|celular|whatsapp|fone|phone|numero|n[uú]mero)$/i.test(String(k).trim()));
  if (preferred) return preferred;
  let best = null, scoreBest = 0;
  for (const key of keys) {
    let score = 0;
    for (const row of rows.slice(0, 30)) if (normalizeBrazilPhone(row[key])) score++;
    if (score > scoreBest) { scoreBest = score; best = key; }
  }
  return scoreBest ? best : null;
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
    contacts: state.contacts.length, contactSource: state.contactSource,
    queued: state.queue.filter(x => x.status === 'pending').length,
    sent: state.sent, failed: state.failed, running: state.running,
    paused: state.paused, cancelled: state.cancelled,
    batchSize: state.batchSize, intervalMinutes: state.intervalMinutes,
    startedAt: state.startedAt, nextBatchAt: state.nextBatchAt,
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

// Leitura síncrona do estado interno do WhatsApp Web. Não usa chat.list/getAllGroups.
async function inspectStore(client, includeMembers = false) {
  if (!client?.page || typeof client.page.evaluate !== 'function') throw new Error('Página do WhatsApp indisponível.');
  return timeout(client.page.evaluate((withMembers) => {
    const W = globalThis.WPP;
    if (!W) return { ready: false, authenticated: false, store: false, groups: [] };

    let authenticated = true;
    try {
      if (W.conn?.isAuthenticated) authenticated = !!W.conn.isAuthenticated();
    } catch (_) {}

    const store = W.whatsapp?.ChatStore;
    const models = store?.models;
    if (!store || !models) return { ready: !!W.isReady, authenticated, store: false, groups: [] };

    const toArray = value => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      try { if (typeof value.values === 'function') return Array.from(value.values()); } catch (_) {}
      try { if (Array.isArray(value.models)) return value.models; } catch (_) {}
      try { return Object.values(value); } catch (_) { return []; }
    };
    const wid = value => {
      if (!value) return '';
      if (typeof value === 'string') return value;
      if (value._serialized) return String(value._serialized);
      try { const s = value.toString?.(); if (s && s !== '[object Object]') return String(s); } catch (_) {}
      if (value.user && value.server) return `${value.user}@${value.server}`;
      return '';
    };

    const chats = toArray(models);
    const groups = [];
    for (const chat of chats) {
      const gm = chat?.groupMetadata;
      const id = wid(chat?.id) || wid(gm?.id);
      const isGroup = id.endsWith('@g.us') || chat?.isGroup === true || !!gm;
      if (!isGroup || !id) continue;

      const participantsRaw = gm?.participants?.models || gm?.participants || chat?.participants?.models || chat?.participants;
      const participants = toArray(participantsRaw);
      const memberIds = withMembers
        ? participants.map(p => wid(p?.id || p)).filter(Boolean)
        : undefined;

      groups.push({
        id,
        name: gm?.subject || chat?.subject || chat?.name || chat?.formattedTitle || 'Grupo sem nome',
        participants: participants.length || null,
        memberIds
      });
    }

    return {
      ready: !!W.isReady || !!store,
      authenticated,
      store: true,
      chatCount: chats.length,
      groups
    };
  }, includeMembers), 8000, 'Leitura da ChatStore');
}

async function refreshReadiness(client) {
  try {
    const info = await inspectStore(client, false);
    whatsapp.connected = !!info.authenticated;
    whatsapp.ready = !!(info.authenticated && info.store);
    whatsapp.status = whatsapp.ready ? 'READY' : (whatsapp.connected ? 'sincronizando' : 'desconectado');
    whatsapp.lastError = null;
    return info;
  } catch (error) {
    whatsapp.ready = false;
    whatsapp.lastError = `WhatsApp conectado, aguardando a interface interna: ${error.message}`;
    return null;
  }
}

async function startWhatsApp({ forceClean = false } = {}) {
  if (whatsapp.starting || whatsapp.client) return;
  whatsapp.starting = true;
  whatsapp.connected = false; whatsapp.ready = false;
  whatsapp.status = 'conectando'; whatsapp.lastError = null; whatsapp.qr = null;
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
        whatsapp.status = 'aguardando_qr'; whatsapp.connected = false; whatsapp.ready = false;
      },
      statusFind: s => {
        whatsapp.status = s || whatsapp.status;
        if (['isLogged', 'inChat', 'qrReadSuccess'].includes(s)) {
          whatsapp.connected = true; whatsapp.qr = null;
        }
        if (['notLogged', 'qrReadFail', 'disconnectedMobile', 'deleteToken', 'browserClose', 'serverClose', 'autocloseCalled'].includes(s)) {
          whatsapp.connected = false; whatsapp.ready = false;
        }
      },
      puppeteerOptions: {
        executablePath: process.env.CHROME_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote']
      }
    }), 90000, 'Inicialização do WhatsApp');

    whatsapp.client = client;
    whatsapp.connected = true;
    whatsapp.status = 'sincronizando';

    if (typeof client.onStateChange === 'function') {
      client.onStateChange(s => {
        if (['DISCONNECTED','UNPAIRED','UNPAIRED_IDLE','CONFLICT'].includes(s)) {
          whatsapp.connected = false; whatsapp.ready = false; whatsapp.status = s;
        } else if (['CONNECTED','READY'].includes(s)) {
          whatsapp.connected = true;
          if (!whatsapp.ready) whatsapp.status = 'sincronizando';
        }
      });
    }

    // A ChatStore costuma aparecer poucos segundos após o login. Tentamos sem travar a aplicação.
    for (let i = 0; i < 20; i++) {
      const info = await refreshReadiness(client);
      if (info?.store && info?.authenticated) break;
      await sleep(2000);
    }
  } catch (error) {
    whatsapp.client = null; whatsapp.connected = false; whatsapp.ready = false;
    whatsapp.status = 'erro'; whatsapp.lastError = error.message;
    console.error('[WHATSAPP]', error);
  } finally {
    whatsapp.starting = false;
  }
}

async function closeWhatsApp({ logout = false } = {}) {
  const client = whatsapp.client;
  whatsapp.client = null; whatsapp.connected = false; whatsapp.ready = false;
  whatsapp.qr = null; whatsapp.lastError = null; cachedGroups.clear();
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

async function getGroupsFromStore() {
  const client = whatsapp.client;
  if (!client) throw new Error('WhatsApp não está conectado.');
  const info = await inspectStore(client, true);
  whatsapp.connected = !!info.authenticated;
  whatsapp.ready = !!(info.authenticated && info.store);
  whatsapp.status = whatsapp.ready ? 'READY' : 'sincronizando';
  if (!info.authenticated) throw new Error('A sessão não está autenticada. Reconecte o WhatsApp.');
  if (!info.store) throw new Error('A ChatStore do WhatsApp ainda não carregou.');

  const groups = (info.groups || []).filter(g => String(g.id).endsWith('@g.us'));
  cachedGroups = new Map(groups.map(g => [g.id, g.memberIds || []]));
  return groups.map(({ memberIds, ...g }) => g).sort((a,b) => String(a.name).localeCompare(String(b.name), 'pt-BR'));
}

async function getMembersFromStore(groupId) {
  if (cachedGroups.has(groupId) && cachedGroups.get(groupId).length) return cachedGroups.get(groupId);
  const info = await inspectStore(whatsapp.client, true);
  const group = (info.groups || []).find(g => g.id === groupId);
  if (!group) throw new Error('Grupo não encontrado na ChatStore. Clique em Carregar grupos novamente.');
  cachedGroups.set(groupId, group.memberIds || []);
  return group.memberIds || [];
}

async function sendWhatsAppText(phone, message) {
  if (!whatsapp.client) throw new Error('WhatsApp não está conectado.');
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
  clearTimeout(timer); timer = setTimeout(runBatch, delay);
}

app.get('/api/status', async (_req, res) => {
  if (whatsapp.client && whatsapp.connected && !whatsapp.ready) await refreshReadiness(whatsapp.client);
  res.json(publicState());
});

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
  await closeWhatsApp({ logout: false }); whatsapp.status = 'desconectado';
  res.json({ ok: true, state: publicState() });
});
app.post('/api/whatsapp/change-number', async (_req, res) => {
  if (state.running) return res.status(409).json({ error: 'Pause ou cancele o envio antes de trocar o número.' });
  await closeWhatsApp({ logout: true }); clearTokens(); whatsapp.status = 'gerando_novo_qr';
  setTimeout(() => startWhatsApp({ forceClean: true }), 700);
  res.json({ ok: true, state: publicState() });
});

app.get('/api/groups', async (_req, res) => {
  try {
    const groups = await getGroupsFromStore();
    console.log(`[GRUPOS V4] ${groups.length} grupos lidos diretamente da ChatStore.`);
    res.json({ ok: true, groups });
  } catch (error) {
    console.error('[GRUPOS V4]', error.message);
    res.status(500).json({ error: `Não consegui ler os grupos da memória do WhatsApp: ${error.message}` });
  }
});

app.post('/api/groups/import', async (req, res) => {
  try {
    const groupId = String(req.body.groupId || '').trim();
    if (!groupId.endsWith('@g.us')) return res.status(400).json({ error: 'Selecione um grupo válido.' });
    const members = await getMembersFromStore(groupId);
    const seen = new Set(), valid = [];
    let invalid = 0, duplicates = 0;
    for (const member of members) {
      const phone = normalizeBrazilPhone(member);
      if (!phone) { invalid++; continue; }
      if (seen.has(phone)) { duplicates++; continue; }
      seen.add(phone); valid.push(phone);
    }
    if (!valid.length) return res.status(400).json({ error: 'O grupo foi encontrado, mas não consegui extrair telefones brasileiros válidos dos participantes.' });
    resetContacts(valid, { type: 'group', groupId });
    res.json({ ok: true, valid: valid.length, invalid, duplicates, preview: valid.slice(0, 8), state: publicState() });
  } catch (error) {
    res.status(500).json({ error: `Não consegui importar os participantes: ${error.message}` });
  }
});

app.post('/api/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecione uma planilha.' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
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
  if (!whatsapp.client || !whatsapp.ready) return res.status(400).json({ error: 'Aguarde o WhatsApp ficar pronto antes de iniciar.' });
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
  state.paused = true; clearTimeout(timer); state.nextBatchAt = null; res.json({ ok: true, state: publicState() });
});
app.post('/api/resume', (_req, res) => {
  if (!state.running || !state.paused) return res.status(400).json({ error: 'Não há envio pausado.' });
  state.paused = false; setImmediate(runBatch); res.json({ ok: true, state: publicState() });
});
app.post('/api/cancel', (_req, res) => {
  state.cancelled = true; state.running = false; state.paused = false; clearTimeout(timer); state.nextBatchAt = null;
  for (const item of state.queue) if (item.status === 'pending') item.status = 'cancelled';
  addLog('-', 'cancelled', 'Fila cancelada pelo operador.'); res.json({ ok: true, state: publicState() });
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
app.listen(port, '0.0.0.0', () => console.log(`Comunicados Alunos v4 em http://0.0.0.0:${port}`));
startWhatsApp({ forceClean: true });
