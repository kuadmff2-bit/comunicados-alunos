const fs = require('fs');
const path = require('path');
const wppconnect = require('@wppconnect-team/wppconnect');

const originalCreate = wppconnect.create.bind(wppconnect);
let recoveryScheduled = false;

function removeSession(sessionDir) {
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.error('[WA RECOVERY] Sessão local removida para forçar novo QR.');
  } catch (e) {
    console.error('[WA RECOVERY] Falha ao limpar sessão:', e.message);
  }
}

function restartProcess(sessionDir, reason) {
  if (recoveryScheduled) return;
  recoveryScheduled = true;
  console.error(`[WA RECOVERY] ${reason}`);
  setTimeout(() => {
    removeSession(sessionDir);
    process.exit(12);
  }, 1500);
}

wppconnect.create = function createWithRecovery(options = {}) {
  const originalStatusFind = options.statusFind;
  const originalCatchQR = options.catchQR;
  const session = String(options.session || 'comunicados-alunos-estavel');
  const tokenDir = options.folderNameToken || process.env.WPP_TOKEN_DIR || path.join(process.cwd(), 'tokens');
  const sessionDir = path.join(tokenDir, session);

  let qrSeen = false;
  let qrAccepted = false;
  let linked = false;
  let lastQrAt = 0;
  let watchdogTimer = null;

  const clearWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = null;
  };

  const patchedOptions = {
    ...options,
    // Dá tempo suficiente para o celular concluir o vínculo após ler o QR.
    deviceSyncTimeout: 300000,
    autoClose: 0,
    waitForLogin: true,
    catchQR: (...args) => {
      qrSeen = true;
      qrAccepted = false;
      lastQrAt = Date.now();
      // Enquanto há QR ativo, não usamos watchdog que mate o processo.
      clearWatchdog();
      try { if (typeof originalCatchQR === 'function') originalCatchQR(...args); } catch (_) {}
    },
    statusFind: (status, ...rest) => {
      try { if (typeof originalStatusFind === 'function') originalStatusFind(status, ...rest); } catch (_) {}

      if (status === 'qrReadSuccess') {
        qrAccepted = true;
        clearWatchdog();
        console.log('[WA RECOVERY] QR lido pelo celular. Aguardando conclusão do vínculo sem reiniciar a sessão.');
      }

      if (status === 'isLogged' || status === 'inChat') {
        linked = true;
        qrAccepted = true;
        clearWatchdog();
      }

      if (status === 'disconnectedMobile') {
        // Só limpa a sessão se não estivermos no meio de um QR recém-gerado/lido.
        const qrRecent = qrSeen && (Date.now() - lastQrAt < 120000);
        if (!qrRecent && !qrAccepted && !linked) {
          restartProcess(sessionDir, 'Sessão antiga recusada pelo WhatsApp. Reiniciando com sessão limpa.');
        }
      }

      // notLogged é estado normal antes do QR; não apaga a sessão automaticamente.
      if (status === 'notLogged' && qrAccepted && !linked) {
        console.warn('[WA RECOVERY] QR aceito, mas ainda não concluiu login. Mantendo a sessão por até 5 minutos.');
      }
    }
  };

  const createPromise = originalCreate(patchedOptions);

  // Watchdog apenas enquanto NENHUM QR foi apresentado. Assim ele não invalida um QR que o usuário está escaneando.
  const watchdog = new Promise((_, reject) => {
    watchdogTimer = setTimeout(() => {
      if (qrSeen || qrAccepted || linked) return;
      reject(new Error('WPPConnect travou antes de gerar QR por mais de 90s'));
    }, 90000);
  });

  return Promise.race([createPromise, watchdog]).then(result => {
    clearWatchdog();
    return result;
  }).catch(error => {
    clearWatchdog();
    if (/travou antes de gerar QR/.test(String(error?.message || ''))) {
      console.error('[WA RECOVERY] Inicialização travou antes do QR. Limpando sessão e reiniciando.');
      removeSession(sessionDir);
      setTimeout(() => process.exit(12), 500);
    }
    throw error;
  });
};

console.log('[WA RECOVERY] Recuperação protegida contra invalidação de QR ativada.');
