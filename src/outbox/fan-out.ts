import type { JobsOptions } from "bullmq";
import type {
  BookingPayload,
  GreetingPayload,
  InAppNotificationType,
  NotificationJobPayload,
  NotificationType,
} from "../events.js";
import type { Booking, Outbox } from "../pg/index.js";
import { findBookingById } from "../pg/bookings.pg.js";
import { findUserById } from "../pg/users.pg.js";
import { findListingById } from "../mongo/listings.mongo.js";

// A job ready to be enqueued: which queue it belongs to, plus the wire payload.
// The relay is what resolves `queue` to the real BullMQ Queue — keeping this
// module free of Redis is what makes the fan-out testable without a connection.
export type QueuedJob =
  | { queue: "emails"; data: BookingPayload | GreetingPayload; opts: JobsOptions }
  | { queue: "notifications"; data: NotificationJobPayload; opts: JobsOptions };

// What each booking transition announces. `recipient` is who the in-app
// notification is for — always the party that did NOT act, since the actor
// already knows what they did.
type BookingEventSpec = {
  email: NotificationType;
  notify: InAppNotificationType;
  recipient: "host" | "guest" | "counterparty";
};

const BOOKING_EVENTS = {
  "booking.created": {
    email: "pending",
    notify: "notify_user",
    recipient: "host",
  },
  "booking.accepted": {
    email: "approved",
    notify: "notify_booking_update",
    recipient: "guest",
  },
  "booking.rejected": {
    email: "rejected",
    notify: "notify_booking_update",
    recipient: "guest",
  },
  // Either party can cancel, so the counterparty is only known from the row.
  "booking.cancelled": {
    email: "cancelled",
    notify: "notify_booking_update",
    recipient: "counterparty",
  },
} as const satisfies Record<string, BookingEventSpec>;

// Mirrors pgBookingToEmailBooking in the API: NUMERIC columns come back from pg
// as strings, and the template expects ISO timestamps.
function toEmailBooking(booking: Booking): BookingPayload["booking"] {
  return {
    id: booking.id,
    checkIn: new Date(booking.start_date).toISOString(),
    checkOut: new Date(booking.end_date).toISOString(),
    guests: booking.guests,
    totalPrice: Number(booking.total_price),
    statusReason: booking.status_reason || undefined,
    refundAmount: Number(booking.refund_amount),
    cancelledBy: booking.cancelled_by ?? undefined,
  };
}

// The outbox row carries ids only, so everything the payloads render is read
// back here — the write path never paid for these lookups.
async function bookingEvent(
  bookingId: string,
  spec: BookingEventSpec,
): Promise<QueuedJob[] | null> {
  const booking = await findBookingById(bookingId);
  if (!booking) return null;

  const [guest, listing] = await Promise.all([
    findUserById(booking.guest_id),
    findListingById(booking.listing_id),
  ]);
  if (!guest || !listing) return null;

  const host = await findUserById(listing.host_id);
  if (!host) return null;

  const counterparty = booking.cancelled_by === "guest" ? host : guest;
  const recipient =
    spec.recipient === "counterparty"
      ? counterparty
      : spec.recipient === "host"
        ? host
        : guest;

  return [
    {
      queue: "notifications",
      data: {
        processorKey: "send-notification",
        type: spec.notify,
        listingId: listing._id,
        bookingId: booking.id,
        userId: recipient.id,
      },
      // At-least-once: a relay that publishes and dies before marking the row
      // republishes it on the next tick. The key collapses those into one job.
      opts: { jobId: `notification-${booking.id}-${spec.email}` },
    },
    {
      queue: "emails",
      data: {
        processorKey: "notify-booking",
        type: spec.email,
        guest: { email: guest.email },
        booking: toEmailBooking(booking),
        host: { name: host.name },
        listing: {
          title: listing.title,
          location: {
            address: listing.location.address,
            city: listing.location.city,
            country: listing.location.country,
          },
        },
      },
      opts: { jobId: `booking-${booking.id}-${spec.email}` },
    },
  ];
}

async function userRegistered(userId: string): Promise<QueuedJob[] | null> {
  const user = await findUserById(userId);
  if (!user) return null;

  return [
    {
      queue: "emails",
      data: { processorKey: "greet-user", email: user.email },
      opts: { jobId: `greet-${user.id}` },
    },
  ];
}

/**
 * Turns an outbox row into the jobs it fans out to.
 *
 * `null` means the row can never be published — unknown event type, or its
 * aggregate is gone — so the relay drops it. Without that distinction a single
 * unrehydratable row is retried on every tick, forever.
 */
export async function toJobs(event: Outbox): Promise<QueuedJob[] | null> {
  if (event.event_type === "user.registered") {
    return userRegistered(event.aggregate_id);
  }

  const spec: BookingEventSpec | undefined =
    BOOKING_EVENTS[event.event_type as keyof typeof BOOKING_EVENTS];

  if (!spec) {
    console.error("[toJobs]: unknown event_type", event.event_type, event.id);
    return null;
  }

  return bookingEvent(event.aggregate_id, spec);
}
