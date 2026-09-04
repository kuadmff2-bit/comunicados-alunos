const fs = require('fs');
const path = require('path');
const Module = require('module');

const target = path.join(__dirname, 'server-v5.js');
let source = fs.readFileSync(target, 'utf8');

// WPPConnect create() only resolves after login when waitForLogin=true.
// In some WhatsApp Web builds WPP.conn.isAuthenticated/WPP.isReady is not a
// reliable boolean, while ChatStore is already fully mounted. That left the
// UI forever in "sincronizando" even though the client and chats existed.
const needle = "const store = W.whatsapp?.ChatStore;\n    if (!store?.models) return { ok:false, auth, ready:!!W.isReady, groups:[] };";
const replacement = "const store = W.whatsapp?.ChatStore;\n    if (store?.models) auth = true;\n    if (!store?.models) return { ok:false, auth, ready:false, groups:[] };";

if (!source.includes(needle)) {
  throw new Error('Não encontrei o trecho esperado do server-v5.js para aplicar a correção de sincronização.');
}
source = source.replace(needle, replacement);

// Do not make every /api/status request execute page.evaluate while syncing.
// The startup loop is responsible for readiness and the groups route can test
// the store directly when requested.
source = source.replace(
  "app.get('/api/status', async (_req,res)=>{ if (wa.client && wa.connected && !wa.ready) await refreshReady(); res.json(publicState()); });",
  "app.get('/api/status', async (_req,res)=>{ res.json(publicState()); });"
);

const mod = new Module(target, module);
mod.filename = target;
mod.paths = Module._nodeModulePaths(__dirname);
mod._compile(source, target);
