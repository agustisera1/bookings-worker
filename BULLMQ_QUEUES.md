# Arquitectura de colas (BullMQ + Redis)

> **Este archivo es compartido entre dos repos** (la app de bookings y el worker).
> Mantené una copia idéntica en ambos. Si cambiás el contrato de un payload, actualizás
> este doc **y** las dos copias en el mismo cambio.

Guía para agregar un nuevo worker o job processor y que quede alineado de los dos lados.
Léela completa antes de escribir código de colas.

---

## Panorama

Dos procesos, un Redis en el medio:

```
┌─────────────────────────┐        Redis         ┌─────────────────────────┐
│  Producer (Next.js app)  │      (BullMQ)        │  Worker (proceso aparte) │
│                          │                      │                          │
│  service ──▶ Queue.add() │ ──── "emails" ────▶  │  Worker(queue).process() │
│             (encola job) │      cola nombrada   │ └─▶ dispatch(processorKey)│
└─────────────────────────┘                      └─────────────────────────┘
```

- El **producer** (esta app) solo **encola**: nunca ejecuta el trabajo pesado (mandar mails, etc.).
  Hoy encola en dos colas: `emails` y `notifications`.
- El **worker** (repo aparte) **consume** y ejecuta. Nunca importa nada del producer: los dos lados se
  hablan **solo** a través del payload JSON que viaja por la cola.
- Por eso el **payload es el contrato**. No hay tipos compartidos por import; se **replican a mano** en
  ambos repos (ver [Regla del contrato espejo](#regla-del-contrato-espejo)).

---

## Reglas del payload (no negociables)

Un payload cruza un boundary de proceso y se **serializa a JSON** en Redis. Por lo tanto:

1. **Mínimo.** Solo los campos que el consumer realmente usa. Nada de filas de DB completas ni
   documentos enteros “por las dudas”.
2. **Sin secretos ni PII de más.** Jamás `password_hash`, tokens, ni el `User` completo. Si necesitás el
   host, mandá `{ name }`, no el row.
3. **JSON-safe.** Nada de `Date`, `ObjectId`, `Buffer`, clases. **Las fechas van como ISO string**
   (`new Date(x).toISOString()`), porque es lo único que sobrevive el transporte de forma honesta.
4. **Autodescriptivo.** El payload trae `processorKey` (ver abajo) para que el worker sepa qué hacer sin
   inspeccionar el resto.
5. **Un tipo, un mapper.** El producer define el `type ...Payload` **y** una función pura
   `to...Payload(...)` que hace el narrowing desde el dominio. El narrowing vive en un solo lugar.

---

## Convenciones

### Conexión a Redis

Los dos procesos apuntan al mismo Redis, pero **cada lado arma la conexión distinto** — no comparten
helper ni las mismas env vars:

- **Producer (esta app):** cuatro vars discretas — `REDIS_HOST`, `REDIS_PORT`, `REDIS_USER`,
  `REDIS_PASSWORD` — validadas una sola vez por `getRedisConnectionParams()` en `lib/redis-config.ts`
  (tira si falta alguna). BullMQ las consume a nivel top-level; el subscriber SSE (`lib/subscriber.ts`)
  las anida bajo `socket`.
- **Worker (repo aparte):** una sola var `REDIS_URL`, leída directo en cada cliente
  (`src/redis/workers.ts`, `src/redis/client.ts`, `src/redis/socket.ts`). No replica el helper del producer.

### Nombres de cola

- Una cola = una **familia de trabajo**, no un job puntual. Ej: `"emails"` agrupa todos los mails
  (booking pending, booking accepted, review recibida…); `"notifications"` agrupa las notificaciones in-app.
- El string del nombre de cola es literal y **tiene que ser idéntico** en `new Queue("emails")` (producer)
  y `new Worker("emails")` (worker).

### `processorKey` — ruteo dentro de una cola

Una cola transporta **varios tipos de job**. El discriminante es `processorKey` dentro del payload; el
worker rutea con un **job map** (`Record<processorKey, handler>`) sobre ese campo. El nombre de job de
BullMQ (`queue.add(name, data)`) **no** se usa para rutear hoy — el ruteo es siempre por `processorKey`.

`processorKey` se tipa como **literal** (`"notify-booking"`), no como `string`, para que el job map del
worker se indexe por esos literales; si llega un `processorKey` sin handler, el dispatcher tira (y BullMQ
reintenta).

**`processorKey` vs. una variación del mismo trabajo.** El `processorKey` distingue *trabajos distintos*
(mandar un mail vs. sincronizar a Elasticsearch). Variaciones del **mismo** trabajo — misma plantilla,
distinta copy según el estado — **no** son un `processorKey` nuevo: van con un campo discriminante en el
payload. Ej.: los mails `pending` / `approved` / `rejected` / `updated` / `cancelled` son todos el mismo
`notify-booking` con distinto `type`, no cinco processors. Un `processorKey` nuevo solo se justifica si el
worker haría algo estructuralmente distinto.

---

## Cómo se ve hoy (referencia canónica: email de reserva)

### Producer — `lib/events.ts`

```ts
const connection = getRedisConnectionParams();

// Política de entrega compartida por las dos colas. Vive en el producer porque
// las opciones viajan CON el job a Redis: un restart del worker no cambia la
// política de un job ya encolado.
const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: 1000,  // counts, no booleanos: `true` no deja nada que inspeccionar
  removeOnFail: 5000,
};

export const emailQueue = new Queue("emails", { connection, defaultJobOptions });
export const notificationsQueue = new Queue("notifications", { connection, defaultJobOptions });

// El contrato: mínimo, JSON-safe, sin secretos.
// Un solo processorKey cubre todos los mails de reserva; `type` elige la copy.
export type NotificationType = "pending" | "approved" | "rejected" | "updated" | "cancelled";
export type BookingEmailPayload = {
  processorKey: "notify-booking";
  type: NotificationType;
  guest: { email: string };
  // `statusReason` / `refundAmount` / `cancelledBy` solo significan algo en `cancelled`.
  booking: {
    id: string; checkIn: string; checkOut: string; guests: number; totalPrice: number;
    statusReason?: string; refundAmount?: number; cancelledBy?: "guest" | "host";
  };
  host: { name: string };
  listing: { title: string; location: { address?: string; city?: string; country?: string } };
};

// El mapper puro: único lugar que decide qué campos van al email.
export function toBookingEmailPayload(input: { ... }): BookingEmailPayload { ... }
```

### Producer — `lib/services/bookings.ts`

```ts
// El service junta el dominio, guarda contra datos faltantes y encola el payload narrowed.
async function emailBookingDetails(bookingDetails: EmailBookingParams): Promise<ServiceResult<Job>> {
  const { guestEmail, booking, host, listing } = bookingDetails;
  if (!host || !listing) { /* log + return NOT_FOUND: no encolar un job roto */ }
  try {
    // `jobId` determinístico: nombra el hecho, no la invocación. Ver § Idempotencia.
    const job = await emailQueue.add(
      "emails",
      toBookingEmailPayload({ guestEmail, booking, host, listing }),
      { jobId: `booking-${booking.id}-${type}` },
    );
    return { ok: true, data: job };
  } catch (error) { /* log + ServiceResult UNEXPECTED */ }
}
```

### Worker (repo aparte)

```ts
// Un Worker por cola. `createProcessor` (src/processors/dispatch.ts) busca el handler por
// processorKey en el job map de esa cola; si no existe —o si el handler tira— re-lanza para
// que BullMQ marque el job fallido y lo reintente. Los workers se crean con `autorun: false`
// y se arrancan explícitamente en el bootstrap (src/index.ts).
export const emailsWorker = new Worker("emails", emailsProcessor, { connection, autorun: false });

// El job map de la cola "emails": processorKey -> handler.
const emailsProcessor = createProcessor("emailsProcessor", {
  "greet-user": greetUser,
  "notify-booking": notifyBooking,
});

async function notifyBooking(job: Job) {
  const payload = job.data as BookingPayload; // type replicado en este repo (src/events.ts)
  await resend.emails.send({ to: [payload.guest.email], html: bookingEmailHtml(payload, payload.type), ... });
}
```

---

## Agregar un nuevo job processor

Tomá una decisión primero: **¿entra en una cola existente o necesita una nueva?**
Misma familia de trabajo (otro tipo de mail) → cola existente, nuevo `processorKey`.
Familia distinta con distinto perfil de retry/concurrencia (ej. sync a Elasticsearch) → cola nueva.

### En el producer (esta app)

1. **Definí el contrato** en `lib/events.ts`: `type XxxPayload` con `processorKey: "xxx"` literal,
   mínimo y JSON-safe (fechas ISO).
2. **Definí el mapper** `toXxxPayload(input): XxxPayload` — puro, sin I/O, único lugar de narrowing.
3. **Cola:** reusá una existente (`emailQueue`, `notificationsQueue`) o creá `export const xxxQueue = new Queue("xxx", { connection })`.
4. **Encolá desde el service** (`lib/services/*`), no desde el componente/route. Seguí el patrón de
   `emailBookingDetails`: guardar contra datos faltantes → `queue.add(name, toXxxPayload(...))` dentro de
   try/catch → devolver `ServiceResult`. El encolado es fire-and-forget respecto del happy path.
5. **`tsc` + `lint`** verde.

### En el worker (repo aparte)

1. **Replicá el `type XxxPayload`** exactamente igual (copiá el bloque de `lib/events.ts` del producer a `src/events.ts`).
2. **Nuevo handler** `async function processXxx(job)`: castea `job.data as XxxPayload` y hace el trabajo.
   Si algo falla, dejá que el error propague — `createProcessor` lo loguea y lo re-lanza para que BullMQ reintente.
3. **Registrá el caso** agregándolo al job map que la cola le pasa a `createProcessor` (`{ "xxx": processXxx }`).
4. Si es cola nueva: nuevo `new Worker("xxx", createProcessor("xxxProcessor", { ... }), { autorun: false })` y arrancala en el bootstrap (`src/index.ts`).
5. **`tsc`** verde y el email/efecto renderiza/ocurre igual.

---

## Idempotencia — `jobId` determinístico

BullMQ es *at-least-once*: garantiza que el job se procese **al menos** una vez, no exactamente una.
Con los reintentos activos, el productor tiene que asumir que puede encolar el mismo hecho dos veces.

La herramienta es un `jobId` derivado del evento de dominio. **La clave identifica el hecho, no la
invocación:**

```ts
// La reserva + la etapa del ciclo de vida.
await emailQueue.add("emails", payload, { jobId: `booking-${booking.id}-${type}` });

// Sin etapa que desambiguar: el id del usuario alcanza.
await emailQueue.add("emails", payload, { jobId: `greet-${user.id}` });
```

`type` **tiene que ir en la clave**. Una misma reserva emite `pending`, `approved` y `cancelled`, y
son mails distintos que sí deben salir todos; una clave sin `type` los colapsaría en uno.

### Las dos cotas que hay que tener presentes

**1. La ventana de dedup es la retención, no "para siempre".** BullMQ solo puede descartar un `jobId`
repetido mientras ese job **siga en Redis**. Con `removeOnComplete: 1000`, pasados 1000 jobs
completados el mismo id vuelve a entrar. Es una ventana de volumen, no de tiempo: cuanto más tráfico,
más corta. Si hiciera falta una garantía real de "una sola vez", el dedup tendría que salir de la cola
y pasar a una tabla de efectos ya aplicados.

**2. Protege el encolado, no el envío.** `attempts` reintenta **ese mismo job**; no encola uno nuevo,
así que el `jobId` no interviene. La dedup evita el **doble encolado**; el doble envío dentro de un
mismo job (Resend mandó, la respuesta se perdió, el handler tiró) es otro problema y necesitaría
idempotencia del efecto.

> Esa distinción es la más fácil de pasar por alto: `jobId` resuelve el productor, no el consumer.

---

## Regla del contrato espejo

Los `*Payload` existen **duplicados a propósito** en los dos repos (no hay paquete compartido). Cuando
cambie un contrato:

- [ ] Actualizar `type` **y** mapper en el producer (`lib/events.ts`).
- [ ] Actualizar el `type` replicado en el worker (`src/events.ts`).
- [ ] Actualizar este doc si cambió una convención.
- [ ] `tsc` verde en **ambos** repos.

Al agregar/quitar un campo, pensá la compatibilidad: si hay jobs viejos encolados en Redis, el worker
nuevo tiene que tolerar payloads sin el campo nuevo (campos opcionales o defaults).

---

## Checklist rápido

**Payload:** mínimo · JSON-safe · fechas ISO · sin secretos · `processorKey` literal · un tipo + un mapper.
**Producer:** contrato en `lib/events.ts` · encolar desde el service con guard + try/catch.
**Worker:** type replicado · handler + caso en el job map de la cola · sin secretos que loguear.
