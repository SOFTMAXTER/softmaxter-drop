window.SOFTMAXTER_DROP_CONFIG = {
  // URL pública de tu App Service / SignalR Hub.
  hubBaseUrl: 'https://softmaxterrelay.azurewebsites.net/transferHub',

  // STUN está listo. Para redes difíciles, agrega TURN real aquí.
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
    // Ejemplo TURN:
    // { urls: 'turn:turn.tudominio.com:3478', username: 'usuario', credential: 'clave' }
  ],

  enableFileSystemAccess: true,
  defaultRoomPrefix: 'SOFT'
};
