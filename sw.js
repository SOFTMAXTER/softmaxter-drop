/* SOFTMAXTER DROP - Service Worker
   - Descargas por streaming cuando el navegador lo permite.
   - Cache básico de app shell para PWA.
   - Limpieza automática de descargas activas. */

const CACHE_VERSION = 'softmaxter-drop-v4-cspfinal';
const APP_SHELL = [
  './config.js',
  './inline.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const activeDownloads = new Map();
const DOWNLOAD_TTL_MS = 10 * 60 * 1000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function safeFilename(name) {
  return String(name || 'archivo')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'archivo';
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'INIT_DOWNLOAD') return;

  const port = event.ports && event.ports[0];
  const id = String(data.id || '');
  const metadata = data.metadata || {};
  if (!port || !id) return;

  if (typeof ReadableStream === 'undefined') {
    port.postMessage({ type: 'ERROR', message: 'ReadableStream no está disponible en este navegador.' });
    return;
  }

  let cleanupTimer;
  const stream = new ReadableStream({
    start(controller) {
      port.onmessage = ({ data: msg }) => {
        try {
          if (msg === 'EOF' || (msg && msg.type === 'EOF')) {
            clearTimeout(cleanupTimer);
            controller.close();
            activeDownloads.delete(id);
            port.postMessage({ type: 'DONE' });
            return;
          }

          if (msg === 'ABORT' || (msg && msg.type === 'ABORT')) {
            clearTimeout(cleanupTimer);
            controller.error(new Error('Transferencia cancelada.'));
            activeDownloads.delete(id);
            return;
          }

          if (msg instanceof ArrayBuffer) {
            controller.enqueue(new Uint8Array(msg));
          } else if (ArrayBuffer.isView(msg)) {
            controller.enqueue(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
          }
        } catch (error) {
          activeDownloads.delete(id);
          controller.error(error);
        }
      };
    },
    cancel() {
      clearTimeout(cleanupTimer);
      activeDownloads.delete(id);
      try { port.postMessage({ type: 'ABORT' }); } catch (_) {}
    }
  });

  cleanupTimer = setTimeout(() => {
    activeDownloads.delete(id);
    try { port.postMessage({ type: 'ERROR', message: 'Tiempo de descarga agotado.' }); } catch (_) {}
  }, DOWNLOAD_TTL_MS);

  activeDownloads.set(id, {
    stream,
    metadata: {
      name: safeFilename(metadata.name),
      mimeType: metadata.mimeType || 'application/octet-stream',
      size: Number(metadata.size || 0)
    }
  });

  port.postMessage({ type: 'READY' });
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/\/__download\/([^/]+)/);

  if (match) {
    const id = decodeURIComponent(match[1]);
    const download = activeDownloads.get(id);

    if (!download) {
      event.respondWith(new Response('Descarga no encontrada o expirada.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      }));
      return;
    }

    const { stream, metadata } = download;
    const encodedName = encodeURIComponent(metadata.name).replace(/['()]/g, escape);
    const headers = new Headers({
      'Content-Type': metadata.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${metadata.name.replace(/"/g, '')}"; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache'
    });

    if (metadata.size > 0 && Number.isFinite(metadata.size)) {
      headers.set('Content-Length', String(metadata.size));
    }

    event.respondWith(new Response(stream, { headers }));
    return;
  }

  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request)
        .then((cached) => cached || fetch(event.request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
          return response;
        }))
    );
  }
});
