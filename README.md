# chatlive-webrtc

Base para reuniones web con tres servicios:

- `apps/frontend`: React + Tailwind + componentes estilo shadcn.
- `apps/api`: NestJS, punto de entrada HTTP para crear/unirse a reuniones.
- `apps/sfu`: servidor WebRTC SFU con mediasoup y señalización Socket.IO.

## Ejecutar con Docker

```bash
cp .env.example .env
docker compose up --build
```

Abre `http://localhost:5173`, crea una sala y comparte el link.

## Desarrollo local

```bash
pnpm install
pnpm -r dev
```

URLs por defecto:

- Frontend: `http://localhost:5173`
- API: `http://localhost:3000`
- SFU: `http://localhost:4000`

## Nota WebRTC en Docker

Para pruebas locales se anuncia `127.0.0.1` como IP ICE del SFU. En un servidor real cambia `MEDIASOUP_ANNOUNCED_IP` por la IP publica o DNS del host, y considera TURN para redes restrictivas.

## Raspberry + Cloudflare

La configuración central está en `.env`. Cambia esos valores y ejecuta `docker compose up --build -d` para replicarlo en frontend, API y SFU.

Ejemplo con subdominios:

```env
APP_PUBLIC_URL=https://meet.example.com
API_PUBLIC_URL=https://meet-api.example.com
SFU_PUBLIC_URL=https://meet-sfu.example.com
CORS_ORIGINS=https://meet.example.com
FRONTEND_PORT=5173
API_PORT=3000
SFU_PORT=4000
MEDIASOUP_MIN_PORT=40000
MEDIASOUP_MAX_PORT=40100
MEDIASOUP_ANNOUNCED_IP=TU_IP_PUBLICA
MEDIASOUP_ANNOUNCED_IPS=TU_IP_PUBLICA
```

Recomendación DNS:

- `meet.example.com`: puede ir por Cloudflare proxy hacia el frontend o hacia un reverse proxy local.
- `meet-api.example.com`: puede ir por Cloudflare proxy hacia el backend HTTP.
- `meet-sfu.example.com`: puede ir por Cloudflare proxy solo para la señalización HTTP/WebSocket del SFU.
- RTP/WebRTC de mediasoup no viaja por el proxy HTTP de Cloudflare. Debes abrir/forwardear en el router los puertos `MEDIASOUP_MIN_PORT-MEDIASOUP_MAX_PORT` en UDP, y preferiblemente TCP también, hacia la Raspberry.
- `MEDIASOUP_ANNOUNCED_IP` debe ser la IP pública real que alcanzan los navegadores, no una IP privada tipo `192.168.x.x`.
- Para pruebas con compañeros fuera de tu red, no anuncies IPs privadas tipo `192.168.x.x`; usa solo la IP pública en `MEDIASOUP_ANNOUNCED_IPS`.

Si tu red cambia de IP o hay clientes en redes restrictivas, el siguiente paso es agregar TURN. Cloudflare normal no reemplaza TURN para media WebRTC.
