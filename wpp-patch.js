const wppconnect = require('@wppconnect-team/wppconnect');

const proto = wppconnect?.Whatsapp?.prototype;

if (proto && typeof proto.listChats === 'function') {
  const originalGetAllGroups = proto.getAllGroups;
  proto.getAllGroups = async function patchedGetAllGroups() {
    try {
      const groups = await this.listChats({ onlyGroups: true });
      if (Array.isArray(groups)) return groups;
    } catch (error) {
      console.warn('[WPP PATCH] listChats({onlyGroups:true}) falhou:', error.message);
    }

    if (typeof originalGetAllGroups === 'function') {
      return originalGetAllGroups.call(this, false);
    }
    return [];
  };

  console.log('[WPP PATCH] getAllGroups redirecionado para listChats({ onlyGroups: true }).');
} else {
  console.warn('[WPP PATCH] Não foi possível aplicar o patch de grupos.');
}
