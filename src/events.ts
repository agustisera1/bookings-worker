// Wire contracts for the jobs this worker pulls off the BullMQ queues. Each
// *Payload mirrors the contract the API enqueues (its lib/events.ts) — the
// worker redeclares only the minimal fields it rehydrates from or renders, not
// the full domain entities. The contract is replicated by hand across the two
// repos, so keep these in sync with the API side.

// El id de la fila de `outbox` que originó el job, y la idempotency key de todo
// consumer: la emite el relay, así que sobrevive a los reintentos de BullMQ.
type Claimable = { eventId: string };

export type ListingLocation = {
  address?: string;
  city?: string;
  country?: string;
};

// The two parties to a booking. Mirrors BookingParty in the API
// (lib/types/booking.ts).
export type BookingParty = "guest" | "host";

export type Booking = {
  id: string;
  checkIn: string; // ISO string
  checkOut: string; // ISO string
  guests: number;
  totalPrice: number;
  statusReason?: string;
  // Both set only on `cancelled`. `refundAmount` is what the API's cancellation
  // policy decided is owed back — the worker renders that number, it never
  // recomputes it. Re-deriving the policy here is how the two drift apart.
  refundAmount?: number;
  cancelledBy?: BookingParty;
};

// The kind of in-app notification to build. Mirrors InAppNotificationType in
// the API (lib/events.ts). `type` selects the copy the Mongo row carries and
// whether it lands already-read.
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

// Mirrors NotificationJobPayload enqueued by the API (lib/events.ts). Minimal:
// only the ids the worker rehydrates from, plus the discriminant `type`.
export type NotificationJobPayload = Claimable & {
  processorKey: "send-notification";
  type: InAppNotificationType;
  listingId: string;
  bookingId: string;
  userId: string;
};

// Mirrors BookingEmailPayload enqueued by the API: only the fields the email
// template renders, not the full domain entities. `type` selects the lifecycle
// copy — a single processorKey covers every booking email.
export type BookingPayload = Claimable & {
  processorKey: "notify-booking";
  type: NotificationType;
  guest: { email: string };
  booking: Booking;
  host: { name: string };
  listing: { title: string; location: ListingLocation };
};

// Mirrors WelcomeEmailPayload enqueued by the API (lib/events.ts). Minimal: the
// welcome template only greets by email, so that's the sole field on the wire.
export type GreetingPayload = Claimable & {
  processorKey: "greet-user";
  email: string;
};
