const $ = id => document.getElementById(id);

const fileInput = $('fileInput');
const importBtn = $('importBtn');
const importResult = $('importResult');
const message = $('message');
const charCount = $('charCount');
const batchSize = $('batchSize');
const intervalMinutes = $('intervalMinutes');
const startBtn = $('startBtn');
const pauseBtn = $('pauseBtn');
const resumeBtn = $('resumeBtn');
const cancelBtn = $('cancelBtn');
const statusText = $('statusText');
const modeBadge = $('modeBadge');
const logBody = $('logBody');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function maskPhone(phone) {
  const n = String(phone || '');
  if (n.length < 6 || n === '-') return n;
  return `${n.slice(0, 4)}••••${n.slice(-4)}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Ocorreu um erro.');
  return data;
}

function notify(text, type = 'ok') {
  importResult.classList.remove('hidden');
  importResult.textContent = text;
  importResult.style.background = type === 'error' ? '#fff0f0' : '#edf8f3';
  importResult.style.color = type === 'error' ? '#9d3030' : '#165e44';
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderState(state) {
  $('contactsStat').textContent = state.contacts || 0;
  $('queuedStat').textContent = state.queued || 0;
  $('sentStat').textContent = state.sent || 0;
  $('failedStat').textContent = state.failed || 0;

  modeBadge.textContent = state.dryRun ? 'Modo de teste' : 'Envio real';
  modeBadge.classList.toggle('live', !state.dryRun);

  if (state.running && state.paused) {
    statusText.textContent = `Pausado — ${state.sent} enviados e ${state.queued} pendentes.`;
  } else if (state.running) {
    statusText.textContent = state.nextBatchAt
      ? `Em andamento — próximo lote às ${fmtTime(state.nextBatchAt)}.`
      : 'Enviando lote agora...';
  } else if (state.cancelled) {
    statusText.textContent = 'Envio cancelado.';
  } else if (state.sent || state.failed) {
    statusText.textContent = `Finalizado — ${state.sent} enviados e ${state.failed} falhas.`;
  } else if (state.contacts) {
    statusText.textContent = `${state.contacts} contatos prontos para envio.`;
  } else {
    statusText.textContent = 'Aguardando planilha.';
  }

  startBtn.disabled = state.running || !state.contacts;
  pauseBtn.disabled = !state.running || state.paused;
  resumeBtn.disabled = !state.running || !state.paused;
  cancelBtn.disabled = !state.running;

  if (!state.log?.length) {
    logBody.innerHTML = '<tr><td colspan="4" class="empty">Nenhum envio iniciado.</td></tr>';
    return;
  }

  logBody.innerHTML = state.log.map(item => `
    <tr>
      <td>${escapeHtml(fmtTime(item.time))}</td>
      <td>${escapeHtml(maskPhone(item.phone))}</td>
      <td class="status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</td>
      <td>${escapeHtml(item.detail)}</td>
    </tr>
  `).join('');
}

async function refresh() {
  try {
    const state = await api('/api/status');
    renderState(state);
  } catch (error) {
    statusText.textContent = error.message;
  }
}

message.addEventListener('input', () => {
  charCount.textContent = message.value.length;
});

importBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) return notify('Selecione uma planilha primeiro.', 'error');

  importBtn.disabled = true;
  importBtn.textContent = 'Importando...';
  try {
    const form = new FormData();
    form.append('file', file);
    const data = await api('/api/import', { method: 'POST', body: form });
    notify(`${data.valid} contatos válidos. ${data.duplicates} duplicados e ${data.invalid} inválidos foram ignorados.`);
    await refresh();
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = 'Importar planilha';
  }
});

startBtn.addEventListener('click', async () => {
  if (!message.value.trim()) {
    statusText.textContent = 'Escreva a mensagem antes de iniciar.';
    message.focus();
    return;
  }

  const confirmed = confirm(`Iniciar o envio para os contatos importados?\n\nLote: ${batchSize.value || 5}\nIntervalo: ${intervalMinutes.value || 10} minutos`);
  if (!confirmed) return;

  try {
    const data = await api('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message.value,
        batchSize: Number(batchSize.value),
        intervalMinutes: Number(intervalMinutes.value)
      })
    });
    renderState(data.state);
  } catch (error) {
    statusText.textContent = error.message;
  }
});

pauseBtn.addEventListener('click', async () => {
  try {
    const data = await api('/api/pause', { method: 'POST' });
    renderState(data.state);
  } catch (error) {
    statusText.textContent = error.message;
  }
});

resumeBtn.addEventListener('click', async () => {
  try {
    const data = await api('/api/resume', { method: 'POST' });
    renderState(data.state);
  } catch (error) {
    statusText.textContent = error.message;
  }
});

cancelBtn.addEventListener('click', async () => {
  if (!confirm('Cancelar o restante da fila?')) return;
  try {
    const data = await api('/api/cancel', { method: 'POST' });
    renderState(data.state);
  } catch (error) {
    statusText.textContent = error.message;
  }
});

refresh();
setInterval(refresh, 3000);
