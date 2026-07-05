/* SOFTMAXTER DROP - Service Worker compatible
   Streaming download helper with graceful cleanup. */

const activeDownloads = new Map();
const DOWNLOAD_TTL_MS = 10 * 60 * 1000;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function safeFilename(name) {
  return String(name || 'archivo')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
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
      port.postMessage({ type: 'ABORT' });
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
  if (!match) return;

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
});
