
  (() => {
    'use strict';

    const HUB_BASE_URL = 'https://softmaxterrelay-brhpeugqabbpb8cj.mexicocentral-01.azurewebsites.net/transferHub';
    const CHUNK_SIZE = 16 * 1024;
    const MAX_BUFFERED_AMOUNT = 512 * 1024;
    const PROGRESS_INTERVAL_MS = 120;
    const MEMORY_FALLBACK_WARNING_SIZE = 300 * 1024 * 1024;

    const $ = (id) => document.getElementById(id);
    const ui = {
      statusText: $('connection-status-text'),
      statusDot: $('status-dot'),
      identity: $('my-identity'),
      grid: $('devices-grid'),
      empty: $('empty-state'),
      count: $('device-count'),
      selectionModal: $('selection-modal'),
      requestModal: $('request-modal'),
      progressModal: $('progress-modal'),
      successModal: $('success-modal'),
      progressTitle: $('progress-title'),
      progressSubtitle: $('progress-subtitle'),
      progressBar: $('progress-bar'),
      progressText: $('progress-text'),
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
    let currentUsers = {};
    let incomingMetadata = null;
    let incomingSenderId = null;
    let receivedSize = 0;
    let lastPaintTime = 0;
    let streamPort = null;
    let memoryChunks = [];
    let serviceWorkerControlled = false;
    let transferActive = false;

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
      updateProgress(0);
      showModal(ui.progressModal);
    }

    function hideProgress() { hideModal(ui.progressModal); }

    function updateProgress(percent) {
      const safe = Math.max(0, Math.min(100, Number(percent) || 0));
      ui.progressBar.style.width = safe.toFixed(0) + '%';
      ui.progressText.textContent = safe.toFixed(0) + '%';
    }

    function formatBytes(bytes) {
      const value = Number(bytes || 0);
      if (!value) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
      return `${(value / Math.pow(1024, index)).toFixed(index ? 2 : 0)} ${units[index]}`;
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
      return /android|ios/i.test(detectOS()) || navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820;
    }

    function supportsFolderPicker() {
      const input = document.createElement('input');
      input.type = 'file';
      return 'webkitdirectory' in input && !/ios/i.test(detectOS());
    }

    function supportsCoreFeatures() {
      return Boolean(window.RTCPeerConnection && window.MessageChannel && window.Blob && window.File && window.ArrayBuffer);
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
      ui.count.textContent = `${ids.length} dispositivo${ids.length === 1 ? '' : 's'}`;
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
        toast('Ya hay una transferencia activa. Espera a que termine.');
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
        await navigator.serviceWorker.register('./sw.js', { scope: './' });
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
        setTimeout(finish, 30);
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
      try {
        let offset = 0;
        let lastUpdate = 0;
        while (offset < file.size) {
          if (!dataChannel || dataChannel.readyState !== 'open') throw new Error('Conexión perdida.');
          await waitForLowBuffer(dataChannel);
          const chunk = await readBlobAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));
          dataChannel.send(chunk);
          offset += chunk.byteLength;
          const now = Date.now();
          if (now - lastUpdate > PROGRESS_INTERVAL_MS || offset >= file.size) {
            lastUpdate = now;
            updateProgress((offset / file.size) * 100);
          }
        }
        while (dataChannel && dataChannel.bufferedAmount > 0) await new Promise(r => setTimeout(r, 35));
        if (dataChannel && dataChannel.readyState === 'open') dataChannel.send(JSON.stringify({ type: 'eof' }));
        ui.progressTitle.textContent = '¡Enviado!';
        updateProgress(100);
        setTimeout(hideProgress, 1600);
      } catch (error) {
        console.error(error);
        ui.progressTitle.textContent = 'Transferencia fallida';
        ui.progressSubtitle.textContent = error.message || 'Error desconocido';
        toast(error.message || 'La transferencia falló.');
        setTimeout(hideProgress, 3500);
      } finally {
        transferActive = false;
        pendingFileToSend = null;
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
              name: String(msg.name || 'archivo'),
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

          if (msg.type === 'eof') {
            finishReceive();
          }
          return;
        }

        receiveBinaryChunk(event.data);
      });

      dataChannel.addEventListener('close', () => {
        if (transferActive) toast('La conexión se cerró.');
        cleanupReceiveState(false);
        hideProgress();
        transferActive = false;
      });

      dataChannel.addEventListener('error', () => {
        toast('Error en el canal WebRTC.');
        cleanupReceiveState(false);
        hideProgress();
        transferActive = false;
      });
    }

    function receiveBinaryChunk(chunk) {
      const size = chunk && (chunk.byteLength || chunk.size || 0);
      if (!size) return;

      if (streamPort) {
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
        updateProgress((receivedSize / incomingMetadata.size) * 100);
      }
    }

    function finishReceive() {
      if (streamPort) {
        streamPort.postMessage('EOF');
        return;
      }
      if (!incomingMetadata) return;
      const blob = new Blob(memoryChunks, { type: incomingMetadata.mimeType || 'application/octet-stream' });
      downloadBlob(blob, incomingMetadata.name);
      showSuccessModal(incomingMetadata.name, incomingMetadata.size, incomingSenderId);
      cleanupReceiveState(true);
    }

    function cleanupReceiveState(keepSuccess) {
      streamPort = null;
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
      a.download = filename || 'archivo';
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
      receivedSize = 0;
      memoryChunks = [];
      showProgress('Recibiendo...', incomingMetadata.name);

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

    function closePeerConnection() {
      try { if (dataChannel) dataChannel.close(); } catch (_) {}
      try { if (peerConnection) peerConnection.close(); } catch (_) {}
      dataChannel = null;
      peerConnection = null;
      pendingCandidates = [];
    }

    function createPeerConnection() {
      closePeerConnection();
      peerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
          // Para máxima compatibilidad entre redes NAT estrictas, agrega aquí tu TURN:
          // { urls: 'turn:turn.tudominio.com:3478', username: 'usuario', credential: 'clave' }
        ]
      });

      peerConnection.addEventListener('icecandidate', (event) => {
        if (event.candidate && targetDevice) {
          connection.invoke('SendSignal', targetDevice, JSON.stringify({ ice: event.candidate })).catch(console.error);
        }
      });

      peerConnection.addEventListener('datachannel', (event) => setupDataChannel(event.channel));
      peerConnection.addEventListener('connectionstatechange', () => {
        const state = peerConnection.connectionState;
        if (state === 'failed' || state === 'disconnected') toast('La conexión P2P se interrumpió.');
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
        toast('No se pudo negociar la conexión WebRTC.');
        closePeerConnection();
      }
    }

    async function handleFilesSelect(event) {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (!files.length || !targetDevice) return;

      if (typeof signalR === 'undefined') {
        toast('No se cargó la biblioteca SignalR. Revisa la conexión o hospeda el archivo localmente.');
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
            name: pendingFileToSend.name,
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

    async function startSignalR() {
      if (typeof signalR === 'undefined') {
        setStatus('SignalR no cargó', 'bad');
        toast('No se pudo cargar SignalR desde CDN. Hospédalo localmente para mayor compatibilidad.');
        return;
      }

      const os = detectOS();
      const params = new URLSearchParams({ os });
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

    function wireUi() {
      $('btn-send-files').addEventListener('click', () => { hideModal(ui.selectionModal); ui.fileInput.click(); });
      $('btn-send-folder').addEventListener('click', () => { hideModal(ui.selectionModal); ui.folderInput.click(); });
      $('btn-cancel-selection').addEventListener('click', () => hideModal(ui.selectionModal));
      $('btn-accept').addEventListener('click', acceptTransfer);
      $('btn-reject').addEventListener('click', rejectTransfer);
      $('btn-close-success').addEventListener('click', () => {
        hideModal(ui.successModal);
        incomingMetadata = null;
        transferActive = false;
        closePeerConnection();
      });
      ui.fileInput.addEventListener('change', handleFilesSelect);
      ui.folderInput.addEventListener('change', handleFilesSelect);
      if (!supportsFolderPicker()) ui.btnFolder.disabled = true;
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
      await initServiceWorker();
      await startSignalR();
      if (!serviceWorkerControlled) {
        toast('Modo compatible activado: si el Service Worker aún no controla la página, la recepción usará memoria como respaldo.');
      }
    }

    window.addEventListener('load', boot);
  })();
  