// Wire contracts for the jobs this worker pulls off the BullMQ queues. Since the
// outbox pattern the relay is the only producer, so producer and consumer both
// live in this repo: these types are the single source, not a copy of the app's.
// Each *Payload stays minimal — only the fields the consumer rehydrates from or
// renders, never a full domain entity. Ver docs/architecture/BULLMQ_QUEUES.md.

// El id de la fila de `outbox` que originó el job, y la idempotency key de todo
// consumer: la emite el relay, así que sobrevive a los reintentos de BullMQ.
type Claimable = { eventId: string };

export type ListingLocation = {
  address?: string;
  city?: string;
  country?: string;
};

// The two parties to a booking. Mirrors BookingParty in the app
// (lib/types/booking.ts).
export type BookingParty = "guest" | "host";

export type Booking = {
  id: string;
  checkIn: string; // ISO string
  checkOut: string; // ISO string
  guests: number;
  totalPrice: number;
  statusReason?: string;
  // Both set only on `cancelled`. `refundAmount` is what the app's cancellation
  // policy decided is owed back — the worker renders that number, it never
  // recomputes it. Re-deriving the policy here is how the two drift apart.
  refundAmount?: number;
  cancelledBy?: BookingParty;
};

// The kind of in-app notification to build. `type` selects the copy the Mongo
// row carries and whether it lands already-read.
export type InAppNotificationType =
  | "mark_as_read"
  | "notify_user"
  | "notify_booking_update";

// The lifecycle stage a booking email is announcing. Drives both the subject
// line and the copy variations in the email template.
export type NotificationType =
  | "pending"
  | "approved"
  | "rejected"
  | "updated"
  | "cancelled";

// In-app notification for a booking transition. Minimal: only the ids the
// worker rehydrates from, plus the discriminant `type`.
export type BookingNotificationPayload = Claimable & {
  processorKey: "send-notification";
  type: InAppNotificationType;
  listingId: string;
  bookingId: string;
  userId: string;
};

// Only the fields the email template renders, not the full domain entities.
// `type` selects the lifecycle copy — a single processorKey covers every
// booking email.
export type BookingPayload = Claimable & {
  processorKey: "notify-booking";
  type: NotificationType;
  guest: { email: string };
  booking: Booking;
  host: { name: string };
  listing: { title: string; location: ListingLocation };
};

// Minimal: the welcome template only greets by email, so that's the sole field
// on the wire.
export type GreetingPayload = Claimable & {
  processorKey: "greet-user";
  email: string;
};

// Todo lo que transporta cada cola, en una unión discriminada por
// `processorKey`. El `switch` de cada processor narrowea sobre ese campo: sumar
// un miembro acá sin agregarle su `case` no compila.
export type EmailJob = BookingPayload | GreetingPayload;
export type NotificationJob = BookingNotificationPayload;
