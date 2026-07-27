# ⚙️ bookings-worker

Proceso persistente de **Bookings App** (repo principal: `bookings_app`) — hace todo lo que la app
Next.js (serverless) no puede sostener por sí misma:

- **Consumers de BullMQ** — envían los emails de reserva y arman las notificaciones in-app, de forma
  asíncrona (la app encola; este proceso ejecuta).
- **Servidor socket.io** — el chat host↔guest en vivo, con su Redis adapter para el fan-out entre
  instancias.

## Por qué es un repo aparte

Las dos cosas necesitan un **proceso siempre encendido**: socket.io sostiene conexiones abiertas y los
consumers de BullMQ son loops de vida larga. Eso descarta un runtime serverless (que se muere entre
requests), y es exactamente lo que justifica separar este proceso de la app. La decisión completa está
en el ADR de deploy del repo principal (`bookings_app/docs/tickets/TD-13-deploy-target.md`).

## Arquitectura

```mermaid
flowchart LR
  APP["bookings_app<br/>(encola jobs)"] -->|BullMQ| RD[(Redis)]
  RD --> WK["bookings-worker"]
  CL[Cliente] <-->|socket.io| WK
  WK --> PG[(PostgreSQL)] & MG[(MongoDB)]
```

- **Consume** de las colas `emails` y `notifications` en Redis; **no** encola nada (eso lo hace la app).
- **Sirve** el chat por socket.io: handshake autenticado por token + un ticket firmado que autoriza el
  room. El worker solo verifica la firma; la regla de quién entra vive en la app.
- **Lee** PostgreSQL y MongoDB para rehidratar datos de notificaciones y persistir mensajes.

El *por qué* del transporte realtime está en
`bookings_app/docs/architecture/REAL_TIME_TRANSPORT_AND_FAN_OUT.md`.

## Contratos espejo — ojo acá

Los dos repos se hablan **solo por contratos replicados a mano** (no hay paquete compartido). La fuente
de verdad es el repo de la app; este repo mantiene copias:

- **Payloads de BullMQ** (`src/events.ts`) ← espejo de `bookings_app/lib/events.ts`. La regla completa
  y las convenciones están en [`BULLMQ_QUEUES.md`](./BULLMQ_QUEUES.md) (copia idéntica en ambos repos).
- **Contrato de chat** (`src/chat/types.ts`: `EVENTS`, `ClientMessage`, `MessageAck`, `ChatParties`) ←
  espejo de `bookings_app/lib/socket.ts`.

Si cambia un contrato en la app, el espejo de acá se actualiza **en el mismo cambio**.

## Estructura

```
src/index.ts     Bootstrap: arranca los workers de BullMQ + el servidor socket.io; graceful shutdown
src/processors/  Handlers de jobs (email, notificaciones) + el dispatcher por processorKey
src/chat/        Auth del handshake, autorización del room (ticket) y el flujo de mensajes
src/redis/       Clientes de Redis: workers de BullMQ, pub client y el server socket.io (+ adapter)
src/mongo/ · src/pg/   Acceso a datos (listados, chats, mensajes, notificaciones · usuarios, reservas)
```

## Cómo correrlo

Requiere Redis (colas + adapter), MongoDB y PostgreSQL accesibles.

```bash
npm install
cp .env.example .env      # REDIS_URL · JWT_SECRET · RESEND_API_KEY · Mongo/PG · SOCKET_PORT · CLIENT_ORIGIN
docker compose up -d      # Redis local (opcional)
npm run dev
```

`JWT_SECRET` tiene que ser **el mismo** que el de la app: este proceso verifica los tokens y tickets
que ella firma.

## Comandos

| | |
|---|---|
| `npm run dev` | watch con `tsx` |
| `npm run build` · `npm start` | compila a `dist/` · corre lo compilado |
| `npm test` · `npm run test:watch` | tests (Vitest) |

## Backlog y decisiones

Este repo **no tiene backlog propio**: el backlog priorizado y los ADRs viven en el repo de la app
(`bookings_app/docs/`). Los tickets que tocan este proceso están marcados con
`Repos: … + bookings-worker`.
