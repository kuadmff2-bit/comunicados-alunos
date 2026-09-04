// Corrige a sincronização do dispositivo no WPPConnect atual.
// Na versão atual, deviceSyncTimeout é um tempo em ms; 0 pode encerrar a etapa de vínculo cedo demais.
const wppconnect = require('@wppconnect-team/wppconnect');

const originalCreate = wppconnect.create.bind(wppconnect);

wppconnect.create = function createWithStableSync(options = {}) {
  const patched = {
    ...options,
    // Dá até 5 minutos para o WhatsApp concluir o vínculo/sincronização após ler o QR.
    deviceSyncTimeout: 300000,
    // Mantém o QR disponível até o login terminar, sem autoclose prematuro.
    autoClose: false,
    waitForLogin: true,
    onLoadingScreen: (percent, message) => {
      try {
        if (typeof options.onLoadingScreen === 'function') options.onLoadingScreen(percent, message);
      } catch (_) {}
      console.log(`[WA SYNC] ${percent ?? '?'}% ${message || ''}`);
    },
    statusFind: (status, session) => {
      if (status === 'qrReadSuccess') console.log('[WA SYNC] QR aceito pelo celular; concluindo vínculo do dispositivo...');
      if (status === 'isLogged' || status === 'inChat') console.log('[WA SYNC] Dispositivo vinculado com sucesso.');
      if (typeof options.statusFind === 'function') options.statusFind(status, session);
    }
  };

  return originalCreate(patched);
};

console.log('[WPP FIX] Sincronização pós-QR configurada para até 5 minutos.');
