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
  }, 1200);
}

wppconnect.create = function createWithRecovery(options = {}) {
  const originalStatusFind = options.statusFind;
  const originalCatchQR = options.catchQR;
  const session = String(options.session || 'comunicados-alunos-estavel');
  const tokenDir = options.folderNameToken || process.env.WPP_TOKEN_DIR || path.join(process.cwd(), 'tokens');
  const sessionDir = path.join(tokenDir, session);
  let qrSeen = false;
  let qrAccepted = false;

  const patchedOptions = {
    ...options,
    // 0 estava deixando o vínculo preso em alguns fluxos. Dá tempo real para o dispositivo concluir.
    deviceSyncTimeout: 180000,
    catchQR: (...args) => {
      qrSeen = true;
      try { if (typeof originalCatchQR === 'function') originalCatchQR(...args); } catch (_) {}
    },
    statusFind: (status, ...rest) => {
      try { if (typeof originalStatusFind === 'function') originalStatusFind(status, ...rest); } catch (_) {}

      if (status === 'qrReadSuccess') qrAccepted = true;

      if (status === 'disconnectedMobile') {
        restartProcess(sessionDir, 'Sessão recusada pelo WhatsApp (disconnectedMobile). Reiniciando com sessão limpa.');
      }

      // Se o QR foi aceito e mesmo assim voltou para notLogged, a sessão ficou inválida.
      if (status === 'notLogged' && qrAccepted) {
        restartProcess(sessionDir, 'QR foi aceito, mas a sessão voltou para notLogged. Reiniciando com sessão limpa.');
      }
    }
  };

  const createPromise = originalCreate(patchedOptions);

  // Impede o painel de ficar "reiniciando" por horas se o WPPConnect travar dentro do create().
  const watchdog = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('WPPConnect travou por mais de 90s durante a inicialização')), 90000);
  });

  return Promise.race([createPromise, watchdog]).catch(error => {
    if (/travou por mais de 90s/.test(String(error?.message || ''))) {
      console.error('[WA RECOVERY] Inicialização travada. Limpando sessão e reiniciando o processo.');
      removeSession(sessionDir);
      setTimeout(() => process.exit(12), 500);
    }
    throw error;
  });
};

console.log('[WA RECOVERY] Watchdog de 90s + recuperação automática de sessão ativados.');
