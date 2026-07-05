(() => {
  'use strict';

  const CONFIG = Object.assign({
    hubBaseUrl: 'https://softmaxterrelay.azurewebsites.net/transferHub',
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ],
    enableFileSystemAccess: true,
    defaultRoomPrefix: 'SOFT'
  }, window.SOFTMAXTER_DROP_CONFIG || {});

  const HUB_BASE_URL = String(CONFIG.hubBaseUrl || '').replace(/\/+$/, '');
  const CHUNK_SIZE = 16 * 1024;
  const MAX_BUFFERED_AMOUNT = 512 * 1024;
  const PROGRESS_INTERVAL_MS = 120;
  const MEMORY_FALLBACK_WARNING_SIZE = 300 * 1024 * 1024;
  const ROOM_STORAGE_KEY = 'softmaxter-drop-room';

  const $ = (id) => document.getElementById(id);
  const ui = {
    statusText: $('connection-status-text'),
    statusDot: $('status-dot'),
    identity: $('my-identity'),
    grid: $('devices-grid'),
    empty: $('empty-state'),
    count: $('device-count'),
    roomCode: $('room-code'),
    roomHelp: $('room-help'),
    copyRoom: $('btn-copy-room'),
    changeRoom: $('btn-change-room'),
    installApp: $('btn-install-app'),
    selectionModal: $('selection-modal'),
    requestModal: $('request-modal'),
    progressModal: $('progress-modal'),
    successModal: $('success-modal'),
    progressTitle: $('progress-title'),
    progressSubtitle: $('progress-subtitle'),
    progressBar: $('progress-bar'),
    progressText: $('progress-text'),
    transferStats: $('transfer-stats'),
    cancelTransfer: $('btn-cancel-transfer'),
    fileInput: $('fileInput'),
    folderInput: $('folderInput'),
    btnFolder: $('btn-send-folder'),
    toast: $('toast')
  };

  let connection;
  let myConnectionId = '';
  let peerConnection = null;
  let dataChannel = null;
  let targetDevice = null;
  let pendingCandidates = [];
  let pendingFileToSend = null;
  let lastFailedTransfer = null;
  let currentUsers = {};
  let incomingMetadata = null;
  let incomingSenderId = null;
  let receivedSize = 0;
  let lastPaintTime = 0;
  let streamPort = null;
  let memoryChunks = [];
  let receiveWriter = null;
  let receiveWriteQueue = Promise.resolve();
  let serviceWorkerControlled = false;
  let transferActive = false;
  let transferAbortRequested = false;
  let transferStartTime = 0;
  let installPromptEvent = null;
  let roomId = initializeRoom();

  function setStatus(text, state) {
    ui.statusText.textContent = text;
    ui.statusDot.className = 'dot' + (state ? ' ' + state : '');
  }

  function toast(message, timeout = 4200) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    window.clearTimeout(toast._timer);
    toast._timer = window.setTimeout(() => ui.toast.classList.remove('show'), timeout);
  }

  function showModal(el) { el.classList.add('show'); }
  function hideModal(el) { el.classList.remove('show'); }

  function showProgress(title, subtitle) {
    ui.progressTitle.textContent = title;
    ui.progressSubtitle.textContent = subtitle || '';
    ui.transferStats.textContent = '';
    updateProgress(0);
    showModal(ui.progressModal);
  }

  function hideProgress() { hideModal(ui.progressModal); }

  function updateProgress(percent, doneBytes, totalBytes) {
    const safe = Math.max(0, Math.min(100, Number(percent) || 0));
    ui.progressBar.style.width = safe.toFixed(0) + '%';
    ui.progressText.textContent = safe.toFixed(0) + '%';

    if (Number.isFinite(doneBytes) && Number.isFinite(totalBytes) && totalBytes > 0) {
      const elapsed = Math.max((performance.now() - transferStartTime) / 1000, 0.25);
      const speed = doneBytes / elapsed;
      const remaining = speed > 0 ? Math.max((totalBytes - doneBytes) / speed, 0) : 0;
      ui.transferStats.textContent = `${formatBytes(doneBytes)} / ${formatBytes(totalBytes)} · ${formatBytes(speed)}/s · ${formatTime(remaining)}`;
    }
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return 'casi listo';
    if (seconds < 60) return `${Math.ceil(seconds)} s restantes`;
    return `${Math.ceil(seconds / 60)} min restantes`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!value) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / Math.pow(1024, index)).toFixed(index ? 2 : 0)} ${units[index]}`;
  }

  function validRoomCode(value) {
    return /^[A-Z0-9_-]{4,48}$/.test(String(value || '').toUpperCase());
  }

  function normalizeRoomCode(value) {
    return String(value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '')
      .slice(0, 48);
  }

  function generateRoomCode() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const suffix = Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').toUpperCase().slice(0, 8);
    return `${CONFIG.defaultRoomPrefix || 'SOFT'}-${suffix}`.replace(/[^A-Z0-9_-]/g, '').slice(0, 48);
  }

  function initializeRoom() {
    const url = new URL(window.location.href);
    const fromUrl = normalizeRoomCode(url.searchParams.get('room'));
    const fromStorage = normalizeRoomCode(localStorage.getItem(ROOM_STORAGE_KEY));
    const selected = validRoomCode(fromUrl) ? fromUrl : (validRoomCode(fromStorage) ? fromStorage : generateRoomCode());
    persistRoom(selected);
    return selected;
  }

  function persistRoom(value) {
    localStorage.setItem(ROOM_STORAGE_KEY, value);
    const url = new URL(window.location.href);
    url.searchParams.set('room', value);
    history.replaceState(null, '', url);
  }

  function getRoomLink() {
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomId);
    return url.toString();
  }

  async function copyRoomLink() {
    const link = getRoomLink();
    try {
      await navigator.clipboard.writeText(link);
      toast('Enlace de sala copiado. Ábrelo en el otro dispositivo.');
    } catch (_) {
      window.prompt('Copia este enlace:', link);
    }
  }

  async function changeRoom() {
    const input = window.prompt('Escribe un código de sala o deja vacío para crear uno nuevo:', roomId);
    if (input === null) return;
    const next = input.trim() ? normalizeRoomCode(input) : generateRoomCode();
    if (!validRoomCode(next)) {
      toast('El código debe tener 4 a 48 caracteres: letras, números, guion o guion bajo.');
      return;
    }
    roomId = next;
    persistRoom(roomId);
    ui.roomCode.textContent = roomId;
    currentUsers = {};
    updateDeviceGrid(currentUsers);
    await restartSignalR();
    toast('Sala actualizada. Comparte el nuevo enlace.');
  }

  function detectOS() {
    const ua = navigator.userAgent || '';
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    const isIPadOS = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    if (/iPhone|iPad|iPod/i.test(ua) || isIPadOS) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    if (/Windows/i.test(ua) || /Win/i.test(platform)) return 'windows';
    if (/Mac/i.test(ua) || /Mac/i.test(platform)) return 'mac';
    if (/Linux/i.test(ua) || /Linux/i.test(platform)) return 'linux';
    return 'unknown';
  }

  function isMobileLike() {
    return /android|ios/i.test(detectOS()) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);
  }

  function supportsFolderPicker() {
    const input = document.createElement('input');
    input.type = 'file';
    return 'webkitdirectory' in input && !/ios/i.test(detectOS());
  }

  function supportsCoreFeatures() {
    return Boolean(window.RTCPeerConnection && window.MessageChannel && window.Blob && window.File && window.ArrayBuffer);
  }

  function safeFilename(name) {
    return String(name || 'archivo')
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180) || 'archivo';
  }

  function getDeviceIcon(os) {
    const icons = {
      windows: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>',
      mac: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 16V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8m-4 4h22"/>',
      linux: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2a4 4 0 018 0v2M7 21h10a2 2 0 002-2v-1H5v1a2 2 0 002 2zM12 3a4 4 0 014 4v4H8V7a4 4 0 014-4z"/>',
      android: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/>',
      ios: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/>'
    };
    return icons[os] || '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>';
  }

  function parseUser(dataStr) {
    try {
      const data = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;
      return {
        name: String((data && data.name) || 'Dispositivo'),
        os: String((data && data.os) || 'unknown').toLowerCase()
      };
    } catch (_) {
      return { name: 'Dispositivo', os: 'unknown' };
    }
  }

  function deviceName(id) {
    return parseUser(currentUsers[id]).name;
  }

  function updateDeviceGrid(users) {
    ui.grid.textContent = '';
    const ids = Object.keys(users || {}).filter(id => id !== myConnectionId);
    ui.count.textContent = `${ids.length} dispositivo${ids.length === 1 ? '' : 's'} en la sala`;
    ui.empty.style.display = ids.length ? 'none' : 'block';

    Object.entries(users || {}).forEach(([id, raw]) => {
      const data = parseUser(raw);
      if (id === myConnectionId) {
        ui.identity.textContent = data.name;
        return;
      }

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'device-card';
      card.setAttribute('aria-label', `Enviar archivo a ${data.name}`);

      const iconWrap = document.createElement('span');
      iconWrap.className = 'device-icon';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.innerHTML = getDeviceIcon(data.os);
      iconWrap.appendChild(svg);

      const name = document.createElement('p');
      name.className = 'device-name';
      name.textContent = data.name;

      card.append(iconWrap, name);
      card.addEventListener('click', () => openSendSelector(id, data.os));
      ui.grid.appendChild(card);
    });
  }

  function openSendSelector(id, os) {
    if (transferActive) {
      toast('Ya hay una transferencia activa. Cancélala o espera a que termine.');
      return;
    }
    targetDevice = id;
    const folderAvailable = supportsFolderPicker() && !isMobileLike() && !/android|ios/i.test(os);
    ui.btnFolder.disabled = !folderAvailable;
    ui.btnFolder.title = folderAvailable ? '' : 'La selección de carpetas no está disponible en este navegador/dispositivo.';
    showModal(ui.selectionModal);
  }

  async function initServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      await registration.update().catch(() => undefined);
      await navigator.serviceWorker.ready;
      serviceWorkerControlled = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        serviceWorkerControlled = true;
      });
      return serviceWorkerControlled;
    } catch (error) {
      console.warn('Service worker no disponible:', error);
      return false;
    }
  }

  async function waitForLowBuffer(channel) {
    if (channel.bufferedAmount <= MAX_BUFFERED_AMOUNT) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        channel.removeEventListener('bufferedamountlow', finish);
        resolve();
      };
      channel.bufferedAmountLowThreshold = Math.floor(MAX_BUFFERED_AMOUNT / 2);
      channel.addEventListener('bufferedamountlow', finish, { once: true });
      setTimeout(finish, 35);
    });
  }

  function readBlobAsArrayBuffer(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo.'));
      reader.readAsArrayBuffer(blob);
    });
  }

  async function sendFile(file) {
    transferActive = true;
    transferAbortRequested = false;
    transferStartTime = performance.now();
    try {
      let offset = 0;
      let lastUpdate = 0;
      while (offset < file.size) {
        if (transferAbortRequested) throw new Error('Transferencia cancelada.');
        if (!dataChannel || dataChannel.readyState !== 'open') throw new Error('Conexión perdida.');
        await waitForLowBuffer(dataChannel);
        const chunk = await readBlobAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));
        dataChannel.send(chunk);
        offset += chunk.byteLength;
        const now = Date.now();
        if (now - lastUpdate > PROGRESS_INTERVAL_MS || offset >= file.size) {
          lastUpdate = now;
          updateProgress((offset / file.size) * 100, offset, file.size);
        }
      }
      while (dataChannel && dataChannel.bufferedAmount > 0) await new Promise(r => setTimeout(r, 35));
      if (dataChannel && dataChannel.readyState === 'open') dataChannel.send(JSON.stringify({ type: 'eof' }));
      ui.progressTitle.textContent = '¡Enviado!';
      updateProgress(100, file.size, file.size);
      setTimeout(hideProgress, 1600);
    } catch (error) {
      console.error(error);
      lastFailedTransfer = targetDevice && file ? { targetDevice, file } : null;
      ui.progressTitle.textContent = 'Transferencia fallida';
      ui.progressSubtitle.textContent = error.message || 'Error desconocido';
      toast(error.message || 'La transferencia falló.');
      if (dataChannel && dataChannel.readyState === 'open') {
        try { dataChannel.send(JSON.stringify({ type: 'cancel', reason: error.message || 'failed' })); } catch (_) {}
      }
      setTimeout(hideProgress, 3500);
    } finally {
      transferActive = false;
      pendingFileToSend = null;
      transferAbortRequested = false;
    }
  }

  function setupDataChannel(channel) {
    dataChannel = channel;
    dataChannel.binaryType = 'arraybuffer';

    dataChannel.addEventListener('message', async (event) => {
      if (typeof event.data === 'string') {
        let msg;
        try { msg = JSON.parse(event.data); } catch (_) { return; }

        if (msg.type === 'request') {
          if (transferActive) {
            dataChannel.send(JSON.stringify({ type: 'response', accepted: false, reason: 'busy' }));
            return;
          }
          incomingMetadata = {
            name: safeFilename(msg.name || 'archivo'),
            size: Number(msg.size || 0),
            mimeType: msg.mimeType || 'application/octet-stream'
          };
          incomingSenderId = targetDevice;
          $('request-filename').textContent = incomingMetadata.name;
          $('request-filesize').textContent = formatBytes(incomingMetadata.size);
          $('request-sender').textContent = deviceName(incomingSenderId);
          showModal(ui.requestModal);
          return;
        }

        if (msg.type === 'response') {
          if (msg.accepted && pendingFileToSend) {
            showProgress('Enviando...', pendingFileToSend.name);
            await sendFile(pendingFileToSend);
          } else {
            hideProgress();
            toast(msg.reason === 'busy' ? 'El otro dispositivo está ocupado.' : 'Transferencia rechazada.');
            closePeerConnection();
          }
          return;
        }

        if (msg.type === 'cancel') {
          toast('La otra persona canceló la transferencia.');
          cleanupReceiveState(false);
          hideProgress();
          transferActive = false;
          closePeerConnection();
          return;
        }

        if (msg.type === 'eof') {
          await finishReceive();
        }
        return;
      }

      await receiveBinaryChunk(event.data);
    });

    dataChannel.addEventListener('close', () => {
      if (transferActive) toast('La conexión se cerró.');
      cleanupReceiveState(false);
      hideProgress();
      transferActive = false;
      transferAbortRequested = false;
    });

    dataChannel.addEventListener('error', () => {
      toast('Error en el canal WebRTC.');
      cleanupReceiveState(false);
      hideProgress();
      transferActive = false;
      transferAbortRequested = false;
    });
  }

  async function receiveBinaryChunk(chunk) {
    const size = chunk && (chunk.byteLength || chunk.size || 0);
    if (!size) return;

    if (receiveWriter) {
      const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength || chunk.size || 0);
      receiveWriteQueue = receiveWriteQueue.then(() => receiveWriter.write(bytes));
    } else if (streamPort) {
      try {
        streamPort.postMessage(chunk, chunk instanceof ArrayBuffer ? [chunk] : undefined);
      } catch (_) {
        streamPort.postMessage(chunk);
      }
    } else {
      memoryChunks.push(chunk instanceof ArrayBuffer ? chunk : new Uint8Array(chunk).buffer);
    }

    receivedSize += size;
    const now = Date.now();
    if (incomingMetadata && (now - lastPaintTime > PROGRESS_INTERVAL_MS || receivedSize >= incomingMetadata.size)) {
      lastPaintTime = now;
      updateProgress((receivedSize / incomingMetadata.size) * 100, receivedSize, incomingMetadata.size);
    }
  }

  async function finishReceive() {
    if (!incomingMetadata) return;

    if (receiveWriter) {
      await receiveWriteQueue;
      await receiveWriter.close();
      receiveWriter = null;
      showSuccessModal(incomingMetadata.name, incomingMetadata.size, incomingSenderId);
      cleanupReceiveState(true);
      incomingMetadata = null;
      transferActive = false;
      return;
    }

    if (streamPort) {
      streamPort.postMessage('EOF');
      return;
    }

    const blob = new Blob(memoryChunks, { type: incomingMetadata.mimeType || 'application/octet-stream' });
    downloadBlob(blob, incomingMetadata.name);
    showSuccessModal(incomingMetadata.name, incomingMetadata.size, incomingSenderId);
    cleanupReceiveState(true);
  }

  async function cleanupReceiveState(keepSuccess) {
    if (streamPort) {
      try { streamPort.postMessage('ABORT'); } catch (_) {}
    }
    if (receiveWriter) {
      try { await receiveWriter.abort(); } catch (_) {}
    }
    streamPort = null;
    receiveWriter = null;
    receiveWriteQueue = Promise.resolve();
    memoryChunks = [];
    receivedSize = 0;
    lastPaintTime = 0;
    if (!keepSuccess) incomingMetadata = null;
  }

  function showSuccessModal(filename, filesize, senderId) {
    hideProgress();
    $('success-filename').textContent = filename;
    $('success-filesize').textContent = formatBytes(filesize);
    $('success-sender').textContent = deviceName(senderId);
    showModal(ui.successModal);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeFilename(filename || 'archivo');
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 20_000);
  }

  async function acceptTransfer() {
    if (!incomingMetadata || !dataChannel || dataChannel.readyState !== 'open') return;
    hideModal(ui.requestModal);
    transferActive = true;
    transferAbortRequested = false;
    transferStartTime = performance.now();
    receivedSize = 0;
    memoryChunks = [];
    showProgress('Recibiendo...', incomingMetadata.name);

    const canUseFileSystemAccess = CONFIG.enableFileSystemAccess && window.isSecureContext && typeof window.showSaveFilePicker === 'function';
    if (canUseFileSystemAccess) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: incomingMetadata.name });
        receiveWriter = await handle.createWritable();
        dataChannel.send(JSON.stringify({ type: 'response', accepted: true }));
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') {
          rejectTransfer();
          return;
        }
        console.warn('File System Access no disponible, usando fallback:', error);
      }
    }

    const canStream = serviceWorkerControlled && navigator.serviceWorker.controller && window.isSecureContext;

    if (canStream) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const basePath = window.location.pathname.replace(/\/[^/]*$/, '/');
      const downloadUrl = `${window.location.origin}${basePath}__download/${encodeURIComponent(id)}/${encodeURIComponent(incomingMetadata.name)}`;
      const channel = new MessageChannel();
      streamPort = channel.port1;
      streamPort.onmessage = (e) => {
        const msg = e.data;
        if (msg && msg.type === 'READY') {
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = incomingMetadata.name;
          a.rel = 'noopener';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => a.remove(), 1000);
          dataChannel.send(JSON.stringify({ type: 'response', accepted: true }));
        } else if (msg && msg.type === 'DONE') {
          showSuccessModal(incomingMetadata.name, incomingMetadata.size, incomingSenderId);
          cleanupReceiveState(true);
          incomingMetadata = null;
          transferActive = false;
        } else if (msg && msg.type === 'ERROR') {
          console.warn(msg.message);
          streamPort = null;
        }
      };
      navigator.serviceWorker.controller.postMessage({ type: 'INIT_DOWNLOAD', id, metadata: incomingMetadata }, [channel.port2]);
    } else {
      if (incomingMetadata.size > MEMORY_FALLBACK_WARNING_SIZE) {
        toast('Este navegador guardará el archivo en memoria antes de descargarlo. En archivos grandes puede fallar.');
      }
      dataChannel.send(JSON.stringify({ type: 'response', accepted: true }));
    }
  }

  function rejectTransfer() {
    hideModal(ui.requestModal);
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify({ type: 'response', accepted: false }));
    }
    cleanupReceiveState(false);
    transferActive = false;
    setTimeout(closePeerConnection, 300);
  }

  function cancelTransfer() {
    if (!transferActive && !pendingFileToSend && !incomingMetadata) return;
    transferAbortRequested = true;
    if (dataChannel && dataChannel.readyState === 'open') {
      try { dataChannel.send(JSON.stringify({ type: 'cancel', reason: 'user' })); } catch (_) {}
    }
    cleanupReceiveState(false);
    hideModal(ui.requestModal);
    hideProgress();
    transferActive = false;
    pendingFileToSend = null;
    incomingMetadata = null;
    closePeerConnection();
    toast('Transferencia cancelada.');
  }

  function closePeerConnection() {
    try { if (dataChannel) dataChannel.close(); } catch (_) {}
    try { if (peerConnection) peerConnection.close(); } catch (_) {}
    dataChannel = null;
    peerConnection = null;
    pendingCandidates = [];
  }

  function getIceServers() {
    const servers = Array.isArray(CONFIG.iceServers) ? CONFIG.iceServers : [];
    const filtered = servers.filter(server => server && server.urls);
    return filtered.length ? filtered : [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
  }

  function createPeerConnection() {
    closePeerConnection();
    peerConnection = new RTCPeerConnection({ iceServers: getIceServers() });

    peerConnection.addEventListener('icecandidate', (event) => {
      if (event.candidate && targetDevice) {
        connection.invoke('SendSignal', targetDevice, JSON.stringify({ ice: event.candidate })).catch(console.error);
      }
    });

    peerConnection.addEventListener('datachannel', (event) => setupDataChannel(event.channel));
    peerConnection.addEventListener('connectionstatechange', () => {
      const state = peerConnection.connectionState;
      if (state === 'failed' || state === 'disconnected') toast('La conexión P2P se interrumpió. Si sucede seguido, configura TURN.');
    });
  }

  async function handleSignal(senderId, message) {
    let signal;
    try { signal = JSON.parse(message); } catch (_) { return; }
    targetDevice = senderId;

    try {
      if (signal.sdp) {
        if (signal.sdp.type === 'offer') {
          createPeerConnection();
          await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          while (pendingCandidates.length) await peerConnection.addIceCandidate(pendingCandidates.shift());
          await peerConnection.setLocalDescription(await peerConnection.createAnswer());
          await connection.invoke('SendSignal', senderId, JSON.stringify({ sdp: peerConnection.localDescription }));
        } else if (signal.sdp.type === 'answer' && peerConnection) {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          while (pendingCandidates.length) await peerConnection.addIceCandidate(pendingCandidates.shift());
        }
        return;
      }

      if (signal.ice) {
        const candidate = new RTCIceCandidate(signal.ice);
        if (peerConnection && peerConnection.remoteDescription) await peerConnection.addIceCandidate(candidate);
        else pendingCandidates.push(candidate);
      }
    } catch (error) {
      console.error(error);
      toast('No se pudo negociar la conexión WebRTC. Si falla entre redes distintas, configura TURN.');
      closePeerConnection();
    }
  }

  async function handleFilesSelect(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length || !targetDevice) return;

    if (typeof signalR === 'undefined') {
      toast('No se cargó la biblioteca SignalR. Revisa la conexión o coloca la copia local en /vendor.');
      return;
    }

    try {
      if (files.length === 1 && !files[0].webkitRelativePath) {
        pendingFileToSend = files[0];
      } else {
        if (typeof JSZip === 'undefined') {
          toast('No se cargó JSZip. No se puede empaquetar carpeta/varios archivos.');
          return;
        }
        showProgress('Empaquetando...', 'Creando ZIP');
        const zip = new JSZip();
        files.forEach((file) => zip.file(file.webkitRelativePath || file.name, file));
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, (meta) => updateProgress(meta.percent || 0));
        pendingFileToSend = new File([blob], files.length === 1 ? `${files[0].name}.zip` : 'Archivos.zip', { type: 'application/zip' });
      }

      showProgress('Conectando...', 'Creando túnel P2P');
      createPeerConnection();
      const channel = peerConnection.createDataChannel('fileTransfer', { ordered: true });
      setupDataChannel(channel);
      await peerConnection.setLocalDescription(await peerConnection.createOffer());
      await connection.invoke('SendSignal', targetDevice, JSON.stringify({ sdp: peerConnection.localDescription }));

      dataChannel.addEventListener('open', () => {
        showProgress('Esperando...', 'Respuesta del usuario');
        dataChannel.send(JSON.stringify({
          type: 'request',
          name: safeFilename(pendingFileToSend.name),
          size: pendingFileToSend.size,
          mimeType: pendingFileToSend.type || 'application/octet-stream'
        }));
      }, { once: true });
    } catch (error) {
      console.error(error);
      hideProgress();
      toast(error.message || 'No se pudo preparar la transferencia.');
      closePeerConnection();
    }
  }

  async function restartSignalR() {
    try {
      if (connection) {
        connection.off('ReceiveSignal', handleSignal);
        await connection.stop();
      }
    } catch (_) {}
    connection = null;
    myConnectionId = '';
    await startSignalR();
  }

  async function startSignalR() {
    if (typeof signalR === 'undefined') {
      setStatus('SignalR no cargó', 'bad');
      toast('No se pudo cargar SignalR. Coloca /vendor/signalr.min.js o revisa el CDN.');
      return;
    }

    const os = detectOS();
    const params = new URLSearchParams({ os, room: roomId });
    const hubUrl = `${HUB_BASE_URL}?${params.toString()}`;

    connection = new signalR.HubConnectionBuilder()
      .withUrl(hubUrl)
      .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    connection.on('UpdateUserList', (users) => {
      currentUsers = users || {};
      if (myConnectionId) updateDeviceGrid(currentUsers);
    });

    connection.on('ReceiveSignal', handleSignal);

    connection.onreconnecting(() => setStatus('Reconectando...', 'warn'));
    connection.onreconnected((id) => {
      myConnectionId = id || connection.connectionId || myConnectionId;
      setStatus('Conectado', 'ok');
      updateDeviceGrid(currentUsers);
    });
    connection.onclose(() => {
      setStatus('Desconectado', 'bad');
      setTimeout(() => startSignalR().catch(console.error), 5000);
    });

    try {
      await connection.start();
      myConnectionId = connection.connectionId || '';
      setStatus('Conectado', 'ok');
      updateDeviceGrid(currentUsers);
    } catch (error) {
      console.error(error);
      setStatus('Reconectando...', 'bad');
      setTimeout(() => startSignalR().catch(console.error), 5000);
    }
  }

  function setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      installPromptEvent = event;
      ui.installApp.hidden = false;
    });
    ui.installApp.addEventListener('click', async () => {
      if (!installPromptEvent) return;
      installPromptEvent.prompt();
      await installPromptEvent.userChoice.catch(() => null);
      installPromptEvent = null;
      ui.installApp.hidden = true;
    });
  }

  function wireUi() {
    ui.roomCode.textContent = roomId;
    ui.roomHelp.textContent = 'Abre este mismo enlace en otro dispositivo para verlo aquí.';
    ui.copyRoom.addEventListener('click', copyRoomLink);
    ui.changeRoom.addEventListener('click', () => changeRoom().catch(console.error));
    $('btn-send-files').addEventListener('click', () => { hideModal(ui.selectionModal); ui.fileInput.click(); });
    $('btn-send-folder').addEventListener('click', () => { hideModal(ui.selectionModal); ui.folderInput.click(); });
    $('btn-cancel-selection').addEventListener('click', () => hideModal(ui.selectionModal));
    $('btn-accept').addEventListener('click', acceptTransfer);
    $('btn-reject').addEventListener('click', rejectTransfer);
    ui.cancelTransfer.addEventListener('click', cancelTransfer);
    $('btn-close-success').addEventListener('click', () => {
      hideModal(ui.successModal);
      incomingMetadata = null;
      transferActive = false;
      closePeerConnection();
    });
    ui.fileInput.addEventListener('change', handleFilesSelect);
    ui.folderInput.addEventListener('change', handleFilesSelect);
    if (!supportsFolderPicker()) ui.btnFolder.disabled = true;
    setupInstallPrompt();
  }

  async function boot() {
    wireUi();
    if (!window.isSecureContext) {
      setStatus('Requiere HTTPS', 'bad');
      toast('WebRTC, Service Worker y descargas seguras requieren HTTPS o localhost.');
      return;
    }
    if (!supportsCoreFeatures()) {
      setStatus('Navegador no compatible', 'bad');
      toast('Este navegador no soporta WebRTC/DataChannel o APIs de archivo necesarias.');
      return;
    }
    if (!HUB_BASE_URL) {
      setStatus('Falta HUB_BASE_URL', 'bad');
      toast('Configura hubBaseUrl en config.js.');
      return;
    }
    await initServiceWorker();
    await startSignalR();
    if (!serviceWorkerControlled) {
      toast('Modo compatible activado: la recepción usará File System Access o memoria si el Service Worker aún no controla la página.');
    }
  }

  window.addEventListener('load', boot);
})();
