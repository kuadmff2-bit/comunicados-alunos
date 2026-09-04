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

const SESSION = 'comunicados-alunos-estavel';
const TOKEN_DIR = process.env.WPP_TOKEN_DIR || path.join(process.cwd(), 'tokens');
const SESSION_DIR = path.join(TOKEN_DIR, SESSION);
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
fs.mkdirSync(TOKEN_DIR, { recursive: true });

const state = {
  contacts: [], queue: [], running: false, paused: false, cancelled: false,
  batchSize: 5, intervalMinutes: 10, message: '', sent: 0, failed: 0,
  startedAt: null, nextBatchAt: null, log: [], contactSource: null
};
const wa = { client: null, connected: false, ready: false, status: 'iniciando', qr: null, lastError: null, starting: false };
let timer = null;
let cachedGroups = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} excedeu ${Math.round(ms/1000)}s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function cleanChromiumLocks() {
  try {
    if (!fs.existsSync(SESSION_DIR)) return;
    const stack = [SESSION_DIR];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (['SingletonLock','SingletonCookie','SingletonSocket'].includes(e.name)) {
          try { fs.rmSync(full, { force: true }); } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

function digits(v) { return String(v ?? '').replace(/\D/g, ''); }
function normalizeBrazilPhone(value) {
  let n = digits(value);
  if (!n) return null;
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('55')) n = n.slice(2);
  if (n.length === 10 && /^[6-9]/.test(n.slice(2))) n = n.slice(0,2) + '9' + n.slice(2);
  if (n.length !== 11 || !/^9/.test(n.slice(2))) return null;
  return '55' + n;
}
function detectPhoneColumn(rows) {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0] || {});
  const preferred = keys.find(k => /^(telefone|celular|whatsapp|fone|phone|numero|n[uú]mero)$/i.test(String(k).trim()));
  if (preferred) return preferred;
  let best = null, score = 0;
  for (const key of keys) {
    let s = 0;
    for (const row of rows.slice(0,30)) if (normalizeBrazilPhone(row[key])) s++;
    if (s > score) { score = s; best = key; }
  }
  return score ? best : null;
}
function resetContacts(valid, source) {
  state.contacts = valid; state.contactSource = source; state.queue = [];
  state.sent = 0; state.failed = 0; state.log = []; state.running = false;
  state.paused = false; state.cancelled = false; clearTimeout(timer);
}
function addLog(phone, status, detail) {
  state.log.push({ time: new Date().toISOString(), phone, status, detail });
  if (state.log.length > 1000) state.log = state.log.slice(-1000);
}
function publicState() {
  return {
    contacts: state.contacts.length, contactSource: state.contactSource,
    queued: state.queue.filter(x => x.status === 'pending').length,
    sent: state.sent, failed: state.failed, running: state.running, paused: state.paused,
    cancelled: state.cancelled, batchSize: state.batchSize, intervalMinutes: state.intervalMinutes,
    startedAt: state.startedAt, nextBatchAt: state.nextBatchAt, log: state.log.slice(-100).reverse(),
    whatsapp: { connected: wa.connected, ready: wa.ready, status: wa.status, qr: wa.qr, lastError: wa.lastError }
  };
}

async function inspectStore(includeMembers = false) {
  if (!wa.client?.page) throw new Error('Página do WhatsApp ainda não disponível.');
  return withTimeout(wa.client.page.evaluate((membersToo) => {
    const W = globalThis.WPP;
    if (!W) return { ok:false, auth:false, ready:false, groups:[] };
    let auth = false;
    try { auth = W.conn?.isAuthenticated ? !!W.conn.isAuthenticated() : !!W.isReady; } catch (_) {}
    const store = W.whatsapp?.ChatStore;
    if (!store?.models) return { ok:false, auth, ready:!!W.isReady, groups:[] };
    const arr = v => {
      if (!v) return [];
      if (Array.isArray(v)) return v;
      try { if (typeof v.values === 'function') return Array.from(v.values()); } catch (_) {}
      try { if (Array.isArray(v.models)) return v.models; } catch (_) {}
      try { return Object.values(v); } catch (_) { return []; }
    };
    const wid = v => {
      if (!v) return '';
      if (typeof v === 'string') return v;
      if (v._serialized) return String(v._serialized);
      if (v.user && v.server) return `${v.user}@${v.server}`;
      try { const s = v.toString?.(); return s && s !== '[object Object]' ? String(s) : ''; } catch (_) { return ''; }
    };
    const chats = arr(store.models);
    const groups = [];
    for (const chat of chats) {
      const gm = chat?.groupMetadata;
      const id = wid(chat?.id) || wid(gm?.id);
      if (!id.endsWith('@g.us')) continue;
      const ps = arr(gm?.participants?.models || gm?.participants || chat?.participants?.models || chat?.participants);
      groups.push({
        id,
        name: gm?.subject || chat?.subject || chat?.name || chat?.formattedTitle || 'Grupo sem nome',
        participants: ps.length || null,
        memberIds: membersToo ? ps.map(p => wid(p?.id || p)).filter(Boolean) : []
      });
    }
    return { ok:true, auth, ready:!!W.isReady, chatCount:chats.length, groups };
  }, includeMembers), 8000, 'Leitura interna do WhatsApp');
}

async function refreshReady() {
  if (!wa.client) return false;
  try {
    const info = await inspectStore(false);
    wa.connected = !!info.auth;
    wa.ready = !!(info.auth && info.ok);
    wa.status = wa.ready ? 'READY' : (wa.connected ? 'sincronizando' : wa.status);
    if (wa.ready) wa.lastError = null;
    return wa.ready;
  } catch (_) {
    wa.ready = false;
    return false;
  }
}

async function startWhatsApp() {
  if (wa.starting || wa.client) return;
  wa.starting = true; wa.connected = false; wa.ready = false; wa.status = 'conectando'; wa.lastError = null; wa.qr = null;
  cleanChromiumLocks();
  try {
    const puppeteerOptions = { timeout: 120000 };
    if (fs.existsSync(CHROME)) puppeteerOptions.executablePath = CHROME;

    const client = await wppconnect.create({
      session: SESSION,
      catchQR: (base64Qrimg, _asciiQR, attempts) => {
        const q = String(base64Qrimg || '');
        if (q) wa.qr = q.startsWith('data:image') ? q : `data:image/png;base64,${q}`;
        wa.connected = false; wa.ready = false; wa.status = 'aguardando_qr'; wa.lastError = null;
        console.log(`[QR] atualizado, tentativa ${attempts || '?'}`);
      },
      statusFind: status => {
        wa.status = status || wa.status;
        if (['isLogged','inChat'].includes(status)) { wa.connected = true; wa.qr = null; }
        if (['notLogged','qrReadFail','disconnectedMobile','deleteToken','browserClose','serverClose','autocloseCalled'].includes(status)) { wa.connected = false; wa.ready = false; }
        console.log(`[WA] ${status}`);
      },
      headless: true,
      useChrome: true,
      logQR: false,
      autoClose: 0,
      deviceSyncTimeout: 0,
      waitForLogin: true,
      disableWelcome: true,
      updatesLog: true,
      tokenStore: 'file',
      folderNameToken: TOKEN_DIR,
      puppeteerOptions,
      browserArgs: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
    });

    wa.client = client; wa.connected = true; wa.status = 'sincronizando'; wa.qr = null;
    if (typeof client.onStateChange === 'function') {
      client.onStateChange(s => {
        if (['DISCONNECTED','UNPAIRED','UNPAIRED_IDLE','CONFLICT'].includes(s)) { wa.connected = false; wa.ready = false; wa.status = s; }
        else if (['CONNECTED','READY'].includes(s)) { wa.connected = true; if (!wa.ready) wa.status = 'sincronizando'; }
      });
    }
    for (let i=0; i<30; i++) { if (await refreshReady()) break; await sleep(2000); }
  } catch (error) {
    wa.client = null; wa.connected = false; wa.ready = false; wa.status = 'erro'; wa.lastError = error.message;
    console.error('[WA ERRO]', error);
  } finally { wa.starting = false; }
}

async function closeWhatsApp({ logout = false } = {}) {
  const client = wa.client;
  wa.client = null; wa.connected = false; wa.ready = false; wa.qr = null; wa.lastError = null; cachedGroups.clear();
  if (client) {
    if (logout && typeof client.logout === 'function') { try { await withTimeout(client.logout(), 8000, 'logout'); } catch (_) {} }
    if (typeof client.close === 'function') { try { await withTimeout(client.close(), 8000, 'close'); } catch (_) {} }
  }
  cleanChromiumLocks();
}
function clearSession() { fs.rmSync(SESSION_DIR, { recursive:true, force:true }); fs.mkdirSync(TOKEN_DIR, { recursive:true }); }

async function loadGroups() {
  if (!wa.client) throw new Error('WhatsApp não está conectado.');
  const info = await inspectStore(true);
  if (!info.auth) throw new Error('WhatsApp não está autenticado.');
  if (!info.ok) throw new Error('WhatsApp ainda está sincronizando as conversas.');
  wa.connected = true; wa.ready = true; wa.status = 'READY'; wa.lastError = null;
  const groups = (info.groups || []).filter(g => g.id.endsWith('@g.us'));
  cachedGroups = new Map(groups.map(g => [g.id, g.memberIds || []]));
  return groups.map(({memberIds,...g}) => g).sort((a,b)=>String(a.name).localeCompare(String(b.name),'pt-BR'));
}

async function sendWhatsAppText(phone, message) {
  if (!wa.client || !wa.ready) throw new Error('WhatsApp ainda não está pronto.');
  return withTimeout(wa.client.sendText(`${phone}@c.us`, message), 20000, 'sendText');
}
async function runBatch() {
  if (!state.running || state.paused || state.cancelled) return;
  const pending = state.queue.filter(x=>x.status==='pending').slice(0,state.batchSize);
  if (!pending.length) { state.running=false; state.nextBatchAt=null; addLog('-','done','Fila concluída.'); return; }
  for (const item of pending) {
    if (state.paused || state.cancelled) break;
    item.status='sending';
    try { await sendWhatsAppText(item.phone,state.message); item.status='sent'; item.sentAt=new Date().toISOString(); state.sent++; addLog(item.phone,'sent','Enviado.'); }
    catch (e) { item.status='failed'; item.error=e.message; state.failed++; addLog(item.phone,'failed',e.message); }
  }
  if (state.cancelled || state.paused || !state.running) return;
  if (!state.queue.some(x=>x.status==='pending')) { state.running=false; state.nextBatchAt=null; addLog('-','done','Fila concluída.'); return; }
  const delay=state.intervalMinutes*60000; state.nextBatchAt=new Date(Date.now()+delay).toISOString(); clearTimeout(timer); timer=setTimeout(runBatch,delay);
}

app.get('/api/status', async (_req,res)=>{ if (wa.client && wa.connected && !wa.ready) await refreshReady(); res.json(publicState()); });
app.post('/api/whatsapp/reconnect', async (_req,res)=>{ if(state.running)return res.status(409).json({error:'Pause ou cancele o envio antes de reconectar.'}); await closeWhatsApp({logout:false}); wa.status='reiniciando'; setTimeout(startWhatsApp,700); res.json({ok:true,state:publicState()}); });
app.post('/api/whatsapp/disconnect', async (_req,res)=>{ if(state.running)return res.status(409).json({error:'Pause ou cancele o envio antes de desconectar.'}); await closeWhatsApp({logout:false}); wa.status='desconectado'; res.json({ok:true,state:publicState()}); });
app.post('/api/whatsapp/change-number', async (_req,res)=>{ if(state.running)return res.status(409).json({error:'Pause ou cancele o envio antes de trocar o número.'}); await closeWhatsApp({logout:true}); clearSession(); wa.status='gerando_novo_qr'; setTimeout(startWhatsApp,700); res.json({ok:true,state:publicState()}); });
app.get('/api/groups', async (_req,res)=>{ try { const groups=await loadGroups(); res.json({ok:true,groups}); } catch(e) { res.status(500).json({error:`Não consegui carregar os grupos: ${e.message}`}); } });
app.post('/api/groups/import', async (req,res)=>{ try { const id=String(req.body.groupId||'').trim(); if(!id.endsWith('@g.us'))return res.status(400).json({error:'Selecione um grupo válido.'}); if(!cachedGroups.has(id)) await loadGroups(); const members=cachedGroups.get(id)||[]; const seen=new Set(),valid=[]; let invalid=0,duplicates=0; for(const m of members){const p=normalizeBrazilPhone(m);if(!p){invalid++;continue}if(seen.has(p)){duplicates++;continue}seen.add(p);valid.push(p)} if(!valid.length)return res.status(400).json({error:'Grupo encontrado, mas nenhum telefone brasileiro válido pôde ser extraído.'}); resetContacts(valid,{type:'group',groupId:id}); res.json({ok:true,valid:valid.length,invalid,duplicates,preview:valid.slice(0,8),state:publicState()}); } catch(e){res.status(500).json({error:`Não consegui importar os participantes: ${e.message}`});} });
app.post('/api/import', upload.single('file'), (req,res)=>{ try { if(!req.file)return res.status(400).json({error:'Selecione uma planilha.'}); const wb=XLSX.read(req.file.buffer,{type:'buffer'}), ws=wb.Sheets[wb.SheetNames[0]], rows=XLSX.utils.sheet_to_json(ws,{defval:''}); if(!rows.length)return res.status(400).json({error:'A planilha está vazia.'}); const col=detectPhoneColumn(rows); if(!col)return res.status(400).json({error:'Não consegui identificar a coluna de telefone.'}); const seen=new Set(),valid=[]; let invalid=0,duplicates=0; for(const r of rows){const p=normalizeBrazilPhone(r[col]);if(!p){invalid++;continue}if(seen.has(p)){duplicates++;continue}seen.add(p);valid.push(p)} resetContacts(valid,{type:'spreadsheet',file:req.file.originalname}); res.json({ok:true,phoneColumn:col,totalRows:rows.length,valid:valid.length,invalid,duplicates,preview:valid.slice(0,8)}); } catch(e){res.status(400).json({error:`Não foi possível ler a planilha: ${e.message}`});} });
app.post('/api/start',(req,res)=>{const message=String(req.body.message||'').trim(),batchSize=Math.max(1,Math.min(20,Number(req.body.batchSize)||5)),intervalMinutes=Math.max(1,Math.min(1440,Number(req.body.intervalMinutes)||10));if(!wa.client||!wa.ready)return res.status(400).json({error:'Aguarde o WhatsApp ficar pronto.'});if(!state.contacts.length)return res.status(400).json({error:'Importe contatos primeiro.'});if(!message)return res.status(400).json({error:'Escreva a mensagem.'});if(state.running)return res.status(409).json({error:'Já existe um envio em andamento.'});state.message=message;state.batchSize=batchSize;state.intervalMinutes=intervalMinutes;state.queue=state.contacts.map(phone=>({phone,status:'pending'}));state.sent=0;state.failed=0;state.log=[];state.running=true;state.paused=false;state.cancelled=false;state.startedAt=new Date().toISOString();state.nextBatchAt=null;setImmediate(runBatch);res.json({ok:true,state:publicState()});});
app.post('/api/pause',(_req,res)=>{if(!state.running)return res.status(400).json({error:'Não há envio em andamento.'});state.paused=true;clearTimeout(timer);state.nextBatchAt=null;res.json({ok:true,state:publicState()});});
app.post('/api/resume',(_req,res)=>{if(!state.running||!state.paused)return res.status(400).json({error:'Não há envio pausado.'});state.paused=false;setImmediate(runBatch);res.json({ok:true,state:publicState()});});
app.post('/api/cancel',(_req,res)=>{state.cancelled=true;state.running=false;state.paused=false;clearTimeout(timer);state.nextBatchAt=null;for(const x of state.queue)if(x.status==='pending')x.status='cancelled';addLog('-','cancelled','Fila cancelada pelo operador.');res.json({ok:true,state:publicState()});});
app.get('/api/export',(_req,res)=>{const rows=state.queue.map(x=>({telefone:x.phone,status:x.status,enviado_em:x.sentAt||'',erro:x.error||''})),wb=XLSX.utils.book_new(),ws=XLSX.utils.json_to_sheet(rows.length?rows:[{telefone:'',status:'sem dados'}]);XLSX.utils.book_append_sheet(wb,ws,'Relatorio');const buffer=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});res.setHeader('Content-Disposition','attachment; filename="relatorio-comunicados.xlsx"');res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);});

const port=Number(process.env.PORT||3000);
app.listen(port,'0.0.0.0',()=>console.log(`Comunicados Alunos v5 em http://0.0.0.0:${port}`));
startWhatsApp();
