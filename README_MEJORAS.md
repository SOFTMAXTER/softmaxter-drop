# SOFTMAXTER DROP - mejoras aplicadas

## Cambios principales

- Salas privadas por código (`?room=SOFT-XXXXXXX`). Solo los dispositivos en la misma sala se ven entre sí.
- Botón para copiar enlace de sala y botón para cambiar/crear sala.
- Configuración centralizada en `config.js`.
- Preparado para TURN en `config.js` usando `iceServers`.
- PWA básica: `manifest.webmanifest`, iconos y Service Worker con cache de app shell.
- Carga primero librerías locales en `/vendor` y usa CDNJS como respaldo.
- Transferencias con botón de cancelación.
- Progreso con tamaño transferido, velocidad y tiempo estimado.
- Recepción con File System Access API cuando el navegador lo soporta.
- Fallbacks: Service Worker streaming y, si no es posible, descarga en memoria.
- CSP meta básico, sanitización de nombres de archivo y compatibilidad móvil mejorada.

## Configuración obligatoria

Edita `config.js` y ajusta:

```js
hubBaseUrl: 'https://TU-APP.azurewebsites.net/transferHub'
```

Si usas tu App Service anterior:

```js
hubBaseUrl: 'https://softmaxterrelay-brhpeugqabbpb8cj.mexicocentral-01.azurewebsites.net/transferHub'
```

## TURN recomendado

Para máxima compatibilidad entre redes móviles, oficinas, hoteles y NAT estricto, agrega un servidor TURN real:

```js
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:turn.tudominio.com:3478',
    username: 'usuario',
    credential: 'clave'
  }
]
```

Sin TURN, WebRTC puede fallar en algunas redes aunque el backend esté bien.

## Librerías locales opcionales

Coloca en `/vendor`:

- `signalr.min.js`
- `jszip.min.js`

Si no existen, el HTML intentará usar CDNJS.
