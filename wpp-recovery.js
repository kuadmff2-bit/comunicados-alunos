// Recuperação automática de sessão inválida do WPPConnect.
// Se o WhatsApp retornar disconnectedMobile, apagamos apenas a sessão deste robô
// e reiniciamos o processo para que o Railway gere um QR novo limpo.
const fs = require('fs');
const path = require('path');
const wppconnect = require('@wppconnect-team/wppconnect');

const originalCreate = wppconnect.create.bind(wppconnect);
let recoveryScheduled = false;

wppconnect.create = function createWithRecovery(options = {}) {
  const originalStatusFind = options.statusFind;
  const session = String(options.session || 'comunicados-alunos-estavel');
  const tokenDir = options.folderNameToken || process.env.WPP_TOKEN_DIR || path.join(process.cwd(), 'tokens');
  const sessionDir = path.join(tokenDir, session);

  return originalCreate({
    ...options,
    statusFind: (status, ...rest) => {
      try {
        if (typeof originalStatusFind === 'function') originalStatusFind(status, ...rest);
      } catch (_) {}

      if (status === 'disconnectedMobile' && !recoveryScheduled) {
        recoveryScheduled = true;
        console.error('[WA RECOVERY] Sessão inválida/desconectada. Limpando apenas esta sessão e reiniciando para gerar QR novo.');
        setTimeout(() => {
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {
            console.error('[WA RECOVERY] Falha ao limpar sessão:', e.message);
          }
          process.exit(12);
        }, 2000);
      }
    }
  });
};

console.log('[WA RECOVERY] Recuperação automática de disconnectedMobile ativada.');
