# Bookings App Worker — CLAUDE.md

Proceso **worker** (Node, aparte de la app Next.js) para el marketplace de reservas. Es el
consumidor asíncrono del sistema: procesa jobs de las colas BullMQ (emails, notificaciones in-app),
publica el fan-out en tiempo real por Redis pub/sub y sostiene el servidor socket.io del chat
host↔guest.

## Relación con la app principal (repo hermano)

Este repo es el **consumer**; la app Next.js (`bookings_app`) es el **producer**. Los dos procesos
**no comparten código por import**: se hablan **solo** a través del **payload JSON** que viaja por la
cola (o del canal Redis / evento socket.io). Por eso:

- **El payload es el contrato.** Los tipos `*Payload` se **replican a mano** en ambos repos (acá en
  `src/events.ts`, en el producer en `lib/events.ts`). Cambiar un contrato es un cambio en los dos
  lados a la vez — ver la **regla del contrato espejo** en `docs/architecture/BULLMQ_QUEUES.md`.
- **Antes de tocar colas o payloads, leer `docs/architecture/BULLMQ_QUEUES.md`** (copia idéntica a la
  del producer). Define reglas del payload, `processorKey`, y el paso a paso en ambos lados.
- La decisión de transporte en tiempo real (SSE para notificaciones, socket.io para chat, Redis
  pub/sub como fan-out) vive en el repo del producer: `docs/architecture/REAL_TIME_TRANSPORT_AND_FAN_OUT.md`.

### Dónde va la deuda técnica

**Se documenta en `docs/`, nunca en comentarios del código** (en el código, como mucho un puntero
de una línea). Y va **scopeada a lo que la genera**:

| Deuda | Dónde |
|-------|-------|
| De una feature (chat, notificaciones) | En el doc de esa feature, en el **producer**: `bookings_app/docs/tech_debt/<FEATURE>_NEXT_STEPS.md`. La feature cruza los dos repos, así que se documenta una sola vez, del lado que la orquesta |
| De build/verificación de este repo | `docs/tech_debt/TOOLING.md` |

## Stack

- **Runtime**: Node + TypeScript (ESM, `module: NodeNext`), ejecutado con `tsx` en dev.
- **Colas**: BullMQ sobre Redis.
- **Tiempo real**: socket.io (+ `@socket.io/redis-adapter`) para chat; Redis pub/sub para el fan-out
  de notificaciones a la ruta SSE del producer.
- **DBs**: PostgreSQL (`pg`) para usuarios; MongoDB (`mongodb`) para listings, notificaciones y chat.
- **Email**: Resend.

## Comandos

> **Este repo usa `npm`, no `pnpm`** — a diferencia del producer, que sí usa pnpm. El lockfile
> es `package-lock.json`. Correr `pnpm` acá genera un `pnpm-lock.yaml` paralelo y deja los dos
> desincronizados.

```bash
npm run dev      # tsx watch src/index.ts
npm run build    # tsc -> dist/
npm start        # node dist/index.js
```

Verificación: sin Docker/app viva en este flujo — validar con `npm run build` (`tsc` → `dist/`).
No hay lint configurado.

## Estructura del repo

```
src/
  index.ts              Bootstrap: cablea clients, gatea workers, arranca el socket server, shutdown.
  events.ts             Contratos de cola (*Payload) — espejo del producer. NO importa nada de la app.

  redis/
    client.ts           Pub client + `channels` + `publish()` (fan-out de notificaciones a SSE).
    workers.ts          Workers BullMQ (emails, notifications). Conexión por REDIS_URL, autorun:false.
    socket.ts           Server socket.io + redis-adapter + CORS. Cablea el handshake (io.use), los joins por ticket (JOIN_CHAT/LEAVE_CHAT) y el message flow.

  processors/
    dispatch.ts         `createProcessor`: dispatcher genérico por job map (rutea por processorKey).
    email.ts            Job map de la cola "emails": greet-user, notify-booking.
    notifications.ts    Job map de la cola "notifications": send-notification (persist-then-publish).

  pg/
    index.ts            Pool de PostgreSQL + `query<R>()` + tipos `PgUser`, `Booking`.
    users.pg.ts         findUserById
    bookings.pg.ts      findBookingById
  mongo/
    index.ts            Cliente Mongo (promise singleton).
    listings.mongo.ts   findListingById + ListingDocument
    notifications.mongo.ts  insertNotification + NotificationDocument
    messages.mongo.ts   insertMessage + MessageDocument
    chats.mongo.ts      findChatByBookingId, upsertChatByBookingId + ChatDocument

  notifications/
    content.ts          Tabla de copy por InAppNotificationType (title/body/isRead).
    build-notification.ts  Puro: (payload + listing) -> documento de notificación a persistir.

  templates/
    booking-email.ts    `bookingEmailHtml` — tabla de copy por tipo + HTML del mail de reserva.
    greeting-email.ts   `greetingEmailHtml` — mail de bienvenida.

  chat/                 Feature socket.io partida por responsabilidad (ver "Partición por módulos").
    types.ts            ClientMessage, SocketData, AppSocket, enum `EVENTS`; re-exporta MessageDocument.
    auth.ts             verifyToken + authenticateHandshake (paso 1) + authorizeRoom (paso 2); tipos CurrentUser, ChatParties.
    message-flow.ts     Pasos 3–5: emit -> persist -> deliver.

  resend.ts             Cliente Resend (singleton).
  dates.ts              Formatters de fecha compartidos (formatDate, nightsBetween).
  utils.ts              Formatters compartidos (formatMoney, formatAddress).
```

---

## Patrones de desarrollo

### 1. Consumer-only + contrato espejo (bajo acoplamiento entre repos)

El worker **nunca importa del producer**. Toda entrada llega como payload JSON serializado, y el worker
redeclara en `src/events.ts` **solo** los campos mínimos que rehidrata o renderiza — nunca las entidades
de dominio completas. Regla completa: `docs/architecture/BULLMQ_QUEUES.md`.

### 2. Arquitectura en capas + cohesión por carpeta

Cada carpeta agrupa una responsabilidad con una dependencia distinta, y solo conoce a su vecina hacia
abajo:

```
index.ts (bootstrap)
   ↓ arranca
redis/ (transporte: workers BullMQ, pub client, socket server)
   ↓ invoca
processors/ + chat/ (orquestación: qué hacer con cada job / mensaje)
   ↓ usan
notifications/ + templates/ (lógica de dominio: armar documentos / HTML)
   ↓ leen/escriben vía
pg/ + mongo/ (acceso a datos)
```

Los **clients de infra** (`pg/index.ts`, `mongo/index.ts`, `redis/*`, `resend.ts`) no conocen dominio;
los **processors** orquestan; el **dominio** (build-notification, content, templates) es lógica pura.

### 3. Repository Pattern

Igual que en el producer, el acceso a datos se aísla:

- `pg/index.ts` / `mongo/index.ts` → **conexión** + helper de bajo nivel (`query<R>()`, cliente Mongo).
- **Un archivo por feature**, nombrado con la DB como sufijo: `users.pg.ts`, `bookings.pg.ts`,
  `listings.mongo.ts`, `messages.mongo.ts`, `chats.mongo.ts`. Espejo de `lib/repositories/*` en el
  producer. **No** un `repository.ts` por DB con todo adentro: eso mezcla features que no tienen nada
  que ver entre sí y crece sin límite.
- **Una función por operación**, sin lógica de negocio y sin `authorize`.
- Cada archivo **posee el tipo de su documento** (`ListingDocument`, `ChatDocument`, …) y expone un
  `getCollection()` privado, para no repetir el nombre de la DB en cada función.

**Nomenclatura — operación de datos genérica, nunca acción de dominio:**

| Prefijo | Para qué | Ejemplos |
|---------|----------|----------|
| `find*` | Lecturas. `findXById`, `findXsByY` | `findBookingById`, `findMessagesByChatId` |
| `insert*` | Altas | `insertMessage`, `insertChat` |
| `update*` | Modificaciones, recibiendo los `values` a setear | `updateNotification` |
| `delete*` | Bajas | `deleteSessionsByUser` |

❌ `markAsRead`, `rejectBooking`, `createChatIfMissing` — son **decisiones**, y van en el processor o
el módulo de dominio, que delega en el `update*`/`insert*` genérico del repo.

**Regla:** una decisión de dominio ("qué copy lleva la notificación", "qué se persiste", "quién es el
host") vive en el processor / módulo de dominio, no en el repo. El repo solo ofrece el
`find`/`insert`/`update` genérico.

### 4. Dispatcher genérico por `processorKey` (job map, no switch)

`createProcessor(label, jobs)` (`processors/dispatch.ts`) es un dispatcher **genérico y compartido**:
busca el handler en el **job map** de la cola por `job.data.processorKey`, lo ejecuta, y **re-lanza** el
error para que BullMQ marque el job fallido y lo reintente. Cada cola pasa **su propio** map, así un
worker solo corre los jobs que le pertenecen. Alta cohesión (cada feature declara su map) + bajo
acoplamiento (la lógica de dispatch es una sola).

```ts
export const emailsProcessor = createProcessor("emailsProcessor", {
  "greet-user": greetUser,
  "notify-booking": notifyBooking,
});
```

Agregar un job = agregar una entrada al map + replicar el `*Payload`. No se toca el dispatcher.

### 5. Lógica pura separada de I/O

La transformación de datos vive en funciones **puras, sin I/O**, y el processor hace el I/O alrededor:

- `buildNotification(payload, listing)` → arma el documento; no fetchea ni persiste.
- El processor `sendNotification` fetchea (`findUserById`, `findListingById`), llama al builder puro,
  y recién ahí persiste + publica.

Esto hace la lógica testeable sin levantar Redis/DB y baja el acoplamiento. Es la misma regla del
producer (lógica pura fuera del rendering/I-O).

### 6. DRY — formatters y tablas de copy por tipo

- **Formatters compartidos** en un solo lugar: fechas en `dates.ts` (`formatDate`, `nightsBetween`),
  dinero/dirección en `utils.ts` (`formatMoney`, `formatAddress`). Los templates los importan, no los
  reinventan.
- **Copy indexada por tipo con `Record<Type, ...>`** en vez de cadenas de `if/else`:
  `notificationContent` (`notifications/content.ts`) y `notificationCopy` (`templates/booking-email.ts`).
  Un solo `processorKey`; el campo `type` **selecciona** la copy. Agregar un `type` = agregar una fila
  a la tabla, y TypeScript exige cubrir el `Record`.

### 7. Persist-first, fan-out best-effort

La **fuente de verdad es la DB**; la entrega en vivo es descartable. El orden es siempre **persistir
primero, emitir después**:

- Notificaciones: `insertNotification` → `publish(channels.notifications(target), ...)`
  (`processors/notifications.ts`). Si el insert falla, no se publica.
- Chat: `insertMessage` → `socket.to(room).emit(...)` (`chat/message-flow.ts`).

Si el cliente está offline, el mensaje perdido se recupera de la DB en el próximo fetch (ver el doc de
realtime del producer).

### 8. Config por env, clients singleton

- **Redis**: una sola var `REDIS_URL`, leída en cada cliente y **guardada** (`throw if !url`).
- **PG**: `PGUSER/PGPASSWORD/PGHOST/PGPORT/PGDATABASE`. **Mongo**: `MONGODB_URI`. **Resend**:
  `RESEND_API_KEY`. **Email**: `EMAIL_FROM`, `DEV_MODE`, `DEV_EMAIL_TO`. **Socket**: `SOCKET_PORT`,
  `CLIENT_ORIGIN`. **Chat auth**: `JWT_SECRET` — el mismo secreto con que el producer firma el JWT del
  handshake y el ticket de join; `chat/auth.ts` solo verifica con él.
- Cada cliente (pool PG, promise Mongo, pub client, Resend) es **module-level singleton**: se crea una
  vez al importar el módulo.

### 9. Convención ESM / NodeNext

`type: module` + `module: NodeNext`. **Los imports relativos llevan extensión `.js`** aunque el archivo
sea `.ts` (`import { ... } from "./events.js"`). Es obligatorio con NodeNext — respetarlo en cada archivo nuevo.

### 10. Manejo de errores en processors

- Un handler que no puede completar **tira** (`throw new Error("[fn]: ...")`); `createProcessor` loguea
  con el formato `[label]` y **re-lanza** para que BullMQ reintente. No tragar el error salvo que el
  efecto sea best-effort (p. ej. un fallo de Resend se loguea sin frenar el job).
- **Guard contra datos faltantes**: si falta el user/listing para rehidratar, tirar (el job reintenta),
  no encolar/persistir un documento roto.
- Formato de log: `"[nombreDeLaFuncion]"` entre corchetes. **Nunca loguear secretos ni PII de más.**

### 11. Bootstrap y graceful shutdown (`index.ts`)

- **Orden de arranque importa**: `pubClient.connect()` antes de correr los workers (el processor de
  notificaciones publica sobre `pubClient`). Los workers se crean con `autorun: false` justo para
  gatearlos acá.
- `worker.run()` arranca cada loop sin `await` (su promise resuelve recién al cerrar).
- **Shutdown**: `SIGINT`/`SIGTERM` → `worker.close()` + `pubClient.close()`. Cerrar lo que es nuestro.

### 12. Partición de una feature por módulos (chat)

Cuando una feature junta varias responsabilidades, se parte en una carpeta con **un archivo por
responsabilidad** (misma regla que el producer para componentes):

| Archivo | Responsabilidad |
|---------|-----------------|
| `chat/types.ts` | Tipos + enum `EVENTS` compartidos por las piezas. Sin lógica. |
| `chat/auth.ts` | `verifyToken` + `authenticateHandshake` (paso 1) + `authorizeRoom` (paso 2); tipos `CurrentUser`/`ChatParties`. |
| `chat/message-flow.ts` | Flujo de mensaje: emit → persist → deliver (pasos 3–5). |

El chat corre sobre **dos credenciales distintas**, y esa separación es el diseño:

- **Handshake (paso 1) — autentica *quién*.** `io.use(authenticateHandshake)` (`redis/socket.ts`) corre
  una vez por conexión: verifica el JWT de `socket.handshake.auth.token` con `JWT_SECRET` y cuelga el
  usuario en `socket.data`. Sin token válido, la conexión se rechaza.
- **Ticket de join (paso 2) — autoriza *qué*.** El join no viaja en el handshake porque el socket se
  conecta una vez y el cliente cambia de booking después. El **producer** corre la regla de ownership y
  firma un `ChatParties` (chat_id + ambas partes + qué lado es el portador); el worker solo verifica la
  firma y que nombre una parte (`authorizeRoom`) — **sin PG, sin Mongo, sin regla**. La room es el
  `chat_id` del ticket; las partes verificadas quedan por room en `socket.data.rooms`.
- **Message flow (pasos 3–5).** Las partes guardadas al join son la autorización. El `sender_id` sale del
  ticket, nunca del cliente. El documento de chat nace con el primer mensaje (`upsertChatByBookingId`), no
  con el booking. Se **persiste antes de emitir** (`insertMessage` → broadcast); al emisor se lo excluye
  del broadcast y recibe el `_id` real por `ack` para reemplazar el temporal que pintó optimista.

---

## Checklist al agregar código

- [ ] ¿Payload nuevo o cambiado? Replicarlo en **ambos** repos y seguir `docs/architecture/BULLMQ_QUEUES.md`.
- [ ] ¿Acceso a datos? Va en el archivo de **esa feature** (`<feature>.pg.ts` / `<feature>.mongo.ts`),
      con prefijo `find`/`insert`/`update`/`delete`, genérico y sin lógica de negocio.
- [ ] ¿Transformación de datos? Función pura, separada del processor que hace el I/O.
- [ ] ¿Formatter o constante reutilizable? Buscar primero en `dates.ts` / `utils.ts` antes de duplicar.
- [ ] ¿Copy que varía por tipo? Tabla `Record<Type, ...>`, no `if/else`.
- [ ] Persistir **antes** de emitir/publicar. La DB es la fuente de verdad.
- [ ] Imports relativos con extensión `.js`.
- [ ] Handler que falla → `throw` (deja que BullMQ reintente); log `[fn]`; sin secretos.
- [ ] `npm run build` (`tsc`) verde.
