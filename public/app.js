const $ = id => document.getElementById(id);
const fileInput=$('fileInput'), importBtn=$('importBtn'), importResult=$('importResult'), message=$('message'), charCount=$('charCount');
const batchSize=$('batchSize'), intervalMinutes=$('intervalMinutes'), startBtn=$('startBtn'), pauseBtn=$('pauseBtn'), resumeBtn=$('resumeBtn'), cancelBtn=$('cancelBtn');
const statusText=$('statusText'), modeBadge=$('modeBadge'), logBody=$('logBody'), waStatus=$('waStatus'), qrWrap=$('qrWrap'), qrImage=$('qrImage'), reconnectBtn=$('reconnectBtn');
const disconnectBtn=$('disconnectBtn'), changeNumberBtn=$('changeNumberBtn');
const groupSelect=$('groupSelect'), loadGroupsBtn=$('loadGroupsBtn'), importGroupBtn=$('importGroupBtn'), groupResult=$('groupResult');

function escapeHtml(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;')}
function maskPhone(phone){const n=String(phone||'');if(n.length<6||n==='-')return n;return `${n.slice(0,4)}••••${n.slice(-4)}`}
async function api(url,options={}){const r=await fetch(url,options);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Ocorreu um erro.');return d}
function notify(text,type='ok'){importResult.classList.remove('hidden');importResult.textContent=text;importResult.style.background=type==='error'?'#fff0f0':'#edf8f3';importResult.style.color=type==='error'?'#9d3030':'#165e44'}
function groupNotify(text,type='ok'){groupResult.classList.remove('hidden');groupResult.textContent=text;groupResult.style.background=type==='error'?'#fff0f0':'#edf8f3';groupResult.style.color=type==='error'?'#9d3030':'#165e44'}
function fmtTime(iso){if(!iso)return '—';return new Date(iso).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}

function renderState(state){
  $('contactsStat').textContent=state.contacts||0; $('queuedStat').textContent=state.queued||0; $('sentStat').textContent=state.sent||0; $('failedStat').textContent=state.failed||0;
  const wa=state.whatsapp||{};
  if(wa.connected){modeBadge.textContent='WhatsApp conectado';modeBadge.classList.add('live');waStatus.textContent='✅ Conectado e pronto para enviar.';qrWrap.classList.add('hidden')}
  else {modeBadge.textContent='WhatsApp desconectado';modeBadge.classList.remove('live');waStatus.textContent=wa.lastError?`Erro: ${wa.lastError}`:`Status: ${wa.status||'iniciando'}`;if(wa.qr){qrImage.src=wa.qr;qrWrap.classList.remove('hidden')}else qrWrap.classList.add('hidden')}

  if(state.running&&state.paused) statusText.textContent=`Pausado — ${state.sent} enviados e ${state.queued} pendentes.`;
  else if(state.running) statusText.textContent=state.nextBatchAt?`Em andamento — próximo lote às ${fmtTime(state.nextBatchAt)}.`:'Enviando lote agora...';
  else if(state.cancelled) statusText.textContent='Envio cancelado.';
  else if(state.sent||state.failed) statusText.textContent=`Finalizado — ${state.sent} enviados e ${state.failed} falhas.`;
  else if(state.contacts) {
    const origem=state.contactSource?.type==='group'?'grupo do WhatsApp':state.contactSource?.type==='spreadsheet'?'planilha':'fonte atual';
    statusText.textContent=`${state.contacts} contatos prontos para envio (${origem}).`;
  } else statusText.textContent='Aguardando contatos.';

  startBtn.disabled=state.running||!state.contacts||!wa.connected; pauseBtn.disabled=!state.running||state.paused; resumeBtn.disabled=!state.running||!state.paused; cancelBtn.disabled=!state.running;
  reconnectBtn.disabled=state.running;
  disconnectBtn.disabled=state.running||!wa.connected;
  changeNumberBtn.disabled=state.running;
  loadGroupsBtn.disabled=!wa.connected;
  importGroupBtn.disabled=!wa.connected||!groupSelect.value;

  if(!state.log?.length){logBody.innerHTML='<tr><td colspan="4" class="empty">Nenhum envio iniciado.</td></tr>';return}
  logBody.innerHTML=state.log.map(i=>`<tr><td>${escapeHtml(fmtTime(i.time))}</td><td>${escapeHtml(maskPhone(i.phone))}</td><td class="status-${escapeHtml(i.status)}">${escapeHtml(i.status)}</td><td>${escapeHtml(i.detail)}</td></tr>`).join('');
}

async function refresh(){try{renderState(await api('/api/status'))}catch(e){statusText.textContent=e.message}}
message.addEventListener('input',()=>charCount.textContent=message.value.length);
groupSelect.addEventListener('change',()=>{importGroupBtn.disabled=!groupSelect.value});

reconnectBtn.addEventListener('click',async()=>{
  reconnectBtn.disabled=true;reconnectBtn.textContent='Reconectando...';
  try{const d=await api('/api/whatsapp/reconnect',{method:'POST'});renderState(d.state);setTimeout(refresh,1200)}
  catch(e){waStatus.textContent=e.message}
  finally{setTimeout(()=>{reconnectBtn.disabled=false;reconnectBtn.textContent='Reconectar'},2500)}
});

disconnectBtn.addEventListener('click',async()=>{
  if(!confirm('Desconectar o WhatsApp deste painel?\n\nA sessão salva será mantida e você poderá reconectar depois sem trocar o número.'))return;
  disconnectBtn.disabled=true;disconnectBtn.textContent='Desconectando...';
  try{const d=await api('/api/whatsapp/disconnect',{method:'POST'});renderState(d.state)}
  catch(e){waStatus.textContent=e.message}
  finally{disconnectBtn.textContent='Desconectar'}
});

changeNumberBtn.addEventListener('click',async()=>{
  if(!confirm('Trocar o número conectado?\n\nIsso encerrará a sessão atual, apagará somente a autenticação deste WhatsApp e gerará um novo QR Code.'))return;
  changeNumberBtn.disabled=true;changeNumberBtn.textContent='Trocando...';
  try{
    const d=await api('/api/whatsapp/change-number',{method:'POST'});
    groupSelect.innerHTML='<option value="">Aguardando o novo WhatsApp</option>';
    groupResult.classList.add('hidden');
    renderState(d.state);
    setTimeout(refresh,1200);
  }catch(e){waStatus.textContent=e.message}
  finally{setTimeout(()=>{changeNumberBtn.disabled=false;changeNumberBtn.textContent='Trocar número'},3000)}
});

loadGroupsBtn.addEventListener('click',async()=>{
  loadGroupsBtn.disabled=true; loadGroupsBtn.textContent='Carregando...'; groupSelect.innerHTML='<option value="">Carregando grupos...</option>';
  try{
    const d=await api('/api/groups');
    if(!d.groups?.length){groupSelect.innerHTML='<option value="">Nenhum grupo encontrado</option>';groupNotify('Nenhum grupo disponível neste WhatsApp.','error');return}
    groupSelect.innerHTML='<option value="">Selecione um grupo</option>'+d.groups.map(g=>`<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}${g.participants!=null?` (${g.participants})`:''}</option>`).join('');
    groupNotify(`${d.groups.length} grupo(s) encontrado(s). Escolha um e importe os participantes.`);
  }catch(e){groupSelect.innerHTML='<option value="">Não foi possível carregar</option>';groupNotify(e.message,'error')}
  finally{loadGroupsBtn.disabled=false;loadGroupsBtn.textContent='Carregar grupos';importGroupBtn.disabled=!groupSelect.value}
});

importGroupBtn.addEventListener('click',async()=>{
  const groupId=groupSelect.value;if(!groupId)return groupNotify('Selecione um grupo primeiro.','error');
  importGroupBtn.disabled=true;importGroupBtn.textContent='Importando...';
  try{
    const d=await api('/api/groups/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId})});
    groupNotify(`${d.valid} participantes válidos importados. ${d.duplicates} duplicados e ${d.invalid} inválidos foram ignorados.`);
    renderState(d.state);
  }catch(e){groupNotify(e.message,'error')}
  finally{importGroupBtn.disabled=false;importGroupBtn.textContent='Importar participantes'}
});

importBtn.addEventListener('click',async()=>{const file=fileInput.files[0];if(!file)return notify('Selecione uma planilha primeiro.','error');importBtn.disabled=true;importBtn.textContent='Importando...';try{const form=new FormData();form.append('file',file);const d=await api('/api/import',{method:'POST',body:form});notify(`${d.valid} contatos válidos. ${d.duplicates} duplicados e ${d.invalid} inválidos foram ignorados.`);await refresh()}catch(e){notify(e.message,'error')}finally{importBtn.disabled=false;importBtn.textContent='Importar planilha'}});

startBtn.addEventListener('click',async()=>{if(!message.value.trim()){statusText.textContent='Escreva a mensagem antes de iniciar.';message.focus();return}if(!confirm(`Iniciar o envio para os contatos importados?\n\nLote: ${batchSize.value||5}\nIntervalo: ${intervalMinutes.value||10} minutos`))return;try{const d=await api('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:message.value,batchSize:Number(batchSize.value),intervalMinutes:Number(intervalMinutes.value)})});renderState(d.state)}catch(e){statusText.textContent=e.message}});
pauseBtn.addEventListener('click',async()=>{try{renderState((await api('/api/pause',{method:'POST'})).state)}catch(e){statusText.textContent=e.message}});
resumeBtn.addEventListener('click',async()=>{try{renderState((await api('/api/resume',{method:'POST'})).state)}catch(e){statusText.textContent=e.message}});
cancelBtn.addEventListener('click',async()=>{if(!confirm('Cancelar o restante da fila?'))return;try{renderState((await api('/api/cancel',{method:'POST'})).state)}catch(e){statusText.textContent=e.message}});

refresh();setInterval(refresh,3000);
