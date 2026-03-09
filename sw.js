let map = new Map();

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
    if (event.data.type === 'INIT_DOWNLOAD') {
        const url = event.data.url;
        const port = event.ports[0];
        const metadata = event.data.metadata;

        const stream = new ReadableStream({
            start(controller) {
                port.onmessage = ({ data }) => {
                    if (data === 'EOF') {
                        controller.close();
                        port.postMessage('DONE');
                    } else if (data === 'ABORT') {
                        controller.error('Aborted');
                    } else {
                        controller.enqueue(new Uint8Array(data));
                    }
                };
            },
            cancel() {
                port.postMessage('ABORT');
            }
        });

        map.set(url, { stream, metadata });
        port.postMessage('READY');
    }
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.pathname.includes('/__download/')) {
        const downloadData = map.get(url.href);
        if (downloadData) {
            map.delete(url.href);
            const headers = new Headers({
                'Content-Type': downloadData.metadata.mimeType || 'application/octet-stream',
                'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadData.metadata.name)}`,
                'Content-Length': downloadData.metadata.size
            });
            event.respondWith(new Response(downloadData.stream, { headers }));
        }
    }
});
