require('dotenv').config();
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const axios = require('axios');
const path = require('path');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  contacts: [],
  queue: [],
  running: false,
  paused: false,
  cancelled: false,
  batchSize: 5,
  intervalMinutes: 10,
  message: '',
  sent: 0,
  failed: 0,
  startedAt: null,
  nextBatchAt: null,
  log: []
};

let timer = null;

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeBrazilPhone(value) {
  let n = digits(value);
  if (!n) return null;

  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('55')) n = n.slice(2);

  // Aceita DDD + número (10 ou 11 dígitos). Para celular de 10 dígitos,
  // adiciona o 9 quando o número local tem 8 dígitos.
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

  let best = null;
  let bestScore = 0;
  for (const key of keys) {
    let score = 0;
    for (const row of rows.slice(0, 30)) {
      if (normalizeBrazilPhone(row[key])) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return bestScore ? best : null;
}

function publicState() {
  return {
    contacts: state.contacts.length,
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
    dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false',
    log: state.log.slice(-100).reverse()
  };
}

function addLog(phone, status, detail) {
  state.log.push({
    time: new Date().toISOString(),
    phone,
    status,
    detail
  });
  if (state.log.length > 1000) state.log = state.log.slice(-1000);
}

async function sendWhatsAppText(phone, message) {
  const dryRun = String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false';
  if (dryRun) {
    await new Promise(resolve => setTimeout(resolve, 200));
    return { dryRun: true, id: `dry-${Date.now()}-${phone.slice(-4)}` };
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const version = process.env.WHATSAPP_API_VERSION || 'v23.0';

  if (!phoneNumberId || !token) {
    throw new Error('WhatsApp Cloud API não configurada. Defina WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_ACCESS_TOKEN.');
  }

  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
  const response = await axios.post(url, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'text',
    text: { preview_url: false, body: message }
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });

  return response.data;
}

async function runBatch() {
  if (!state.running || state.paused || state.cancelled) return;

  const pending = state.queue.filter(x => x.status === 'pending').slice(0, state.batchSize);
  if (!pending.length) {
    state.running = false;
    state.nextBatchAt = null;
    addLog('-', 'done', 'Fila concluída.');
    return;
  }

  for (const item of pending) {
    if (state.paused || state.cancelled) break;
    item.status = 'sending';
    try {
      await sendWhatsAppText(item.phone, state.message);
      item.status = 'sent';
      item.sentAt = new Date().toISOString();
      state.sent++;
      addLog(item.phone, 'sent', String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false' ? 'Simulado com sucesso.' : 'Enviado.');
    } catch (error) {
      item.status = 'failed';
      item.error = error.response?.data?.error?.message || error.message;
      state.failed++;
      addLog(item.phone, 'failed', item.error);
    }
  }

  if (state.cancelled || state.paused || !state.running) return;

  const remaining = state.queue.some(x => x.status === 'pending');
  if (!remaining) {
    state.running = false;
    state.nextBatchAt = null;
    addLog('-', 'done', 'Fila concluída.');
    return;
  }

  const delay = state.intervalMinutes * 60 * 1000;
  state.nextBatchAt = new Date(Date.now() + delay).toISOString();
  clearTimeout(timer);
  timer = setTimeout(runBatch, delay);
}

app.post('/api/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecione uma planilha.' });
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'A planilha está vazia.' });

    const phoneColumn = detectPhoneColumn(rows);
    if (!phoneColumn) return res.status(400).json({ error: 'Não consegui identificar a coluna de telefone.' });

    const seen = new Set();
    const valid = [];
    let invalid = 0;
    let duplicates = 0;

    for (const row of rows) {
      const phone = normalizeBrazilPhone(row[phoneColumn]);
      if (!phone) {
        invalid++;
        continue;
      }
      if (seen.has(phone)) {
        duplicates++;
        continue;
      }
      seen.add(phone);
      valid.push(phone);
    }

    state.contacts = valid;
    state.queue = [];
    state.sent = 0;
    state.failed = 0;
    state.log = [];
    state.running = false;
    state.paused = false;
    state.cancelled = false;
    clearTimeout(timer);

    res.json({
      ok: true,
      phoneColumn,
      totalRows: rows.length,
      valid: valid.length,
      invalid,
      duplicates,
      preview: valid.slice(0, 8)
    });
  } catch (error) {
    res.status(400).json({ error: `Não foi possível ler a planilha: ${error.message}` });
  }
});

app.post('/api/start', (req, res) => {
  const message = String(req.body.message || '').trim();
  const batchSize = Math.max(1, Math.min(20, Number(req.body.batchSize) || 5));
  const intervalMinutes = Math.max(1, Math.min(1440, Number(req.body.intervalMinutes) || 10));

  if (!state.contacts.length) return res.status(400).json({ error: 'Importe uma planilha primeiro.' });
  if (!message) return res.status(400).json({ error: 'Escreva a mensagem.' });
  if (state.running) return res.status(409).json({ error: 'Já existe um envio em andamento.' });

  state.message = message;
  state.batchSize = batchSize;
  state.intervalMinutes = intervalMinutes;
  state.queue = state.contacts.map(phone => ({ phone, status: 'pending' }));
  state.sent = 0;
  state.failed = 0;
  state.log = [];
  state.running = true;
  state.paused = false;
  state.cancelled = false;
  state.startedAt = new Date().toISOString();
  state.nextBatchAt = null;

  addLog('-', 'started', `Envio iniciado: ${state.contacts.length} contatos, lotes de ${batchSize} a cada ${intervalMinutes} min.`);
  runBatch();
  res.json({ ok: true, state: publicState() });
});

app.post('/api/pause', (req, res) => {
  if (!state.running) return res.status(400).json({ error: 'Não há envio em andamento.' });
  state.paused = true;
  state.nextBatchAt = null;
  clearTimeout(timer);
  addLog('-', 'paused', 'Envio pausado.');
  res.json({ ok: true, state: publicState() });
});

app.post('/api/resume', (req, res) => {
  if (!state.running) return res.status(400).json({ error: 'Não há envio para continuar.' });
  if (!state.paused) return res.status(400).json({ error: 'O envio não está pausado.' });
  state.paused = false;
  addLog('-', 'resumed', 'Envio retomado.');
  runBatch();
  res.json({ ok: true, state: publicState() });
});

app.post('/api/cancel', (req, res) => {
  state.cancelled = true;
  state.running = false;
  state.paused = false;
  state.nextBatchAt = null;
  clearTimeout(timer);
  for (const item of state.queue) {
    if (item.status === 'pending') item.status = 'cancelled';
  }
  addLog('-', 'cancelled', 'Envio cancelado.');
  res.json({ ok: true, state: publicState() });
});

app.get('/api/status', (req, res) => res.json(publicState()));

app.get('/api/export', (req, res) => {
  const rows = state.queue.map(item => ({
    telefone: item.phone,
    status: item.status,
    enviado_em: item.sentAt || '',
    erro: item.error || ''
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Relatorio');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="relatorio-comunicados.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo maior que 5 MB.' : err.message });
  }
  next(err);
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Comunicados Alunos rodando na porta ${port}`);
});
