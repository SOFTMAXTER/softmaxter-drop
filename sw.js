/* SOFTMAXTER DROP - Service Worker
   - Descargas por streaming cuando el navegador lo permite.
   - Cache básico de app shell para PWA.
   - Manejo seguro de errores de red para evitar FetchEvent rejected. */

const CACHE_VERSION = 'softmaxter-drop-v5-swfix';
const APP_SHELL = [
  './',
  './index.html',
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

async function offlineHtmlResponse() {
  const cached = await caches.match('./index.html', { ignoreSearch: true })
    || await caches.match('./', { ignoreSearch: true });

  if (cached) return cached;

  return new Response(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Softmaxter Drop</title>
</head>
<body style="font-family:system-ui,sans-serif;padding:24px;line-height:1.5">
  <h1>Softmaxter Drop</h1>
  <p>No se pudo cargar la app desde la red y todavía no hay una copia en caché.</p>
  <p>Revisa tu conexión e intenta recargar la página.</p>
</body>
</html>`, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_VERSION);

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put('./index.html', response.clone());
      await cache.put('./', response.clone());
    }
    return response;
  } catch (_) {
    return offlineHtmlResponse();
  }
}

async function cacheFirstSameOrigin(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok && response.type !== 'opaque') {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    return new Response('Recurso no disponible sin conexión.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
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
    event.respondWith(networkFirstNavigation(event.request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirstSameOrigin(event.request));
  }
});
