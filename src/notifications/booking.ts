import type {
  BookingNotificationPayload,
  InAppNotificationType,
} from "../events.js";
import { findListingById } from "../mongo/listings.mongo.js";
import {
  insertNotification,
  type NotificationDocumentPayload,
} from "../mongo/notifications.mongo.js";
import { findUserById } from "../pg/users.pg.js";
import { channels, publish } from "../redis/client.js";

// The in-app notification for a booking transition, end to end: its copy, the
// document it builds, and the handler the "notifications" queue routes to.

// The listing shape findListingById returns (a Mongo doc with a stringified
// _id). Derived from the repository so it stays in step with what that actually
// hands back, instead of re-declaring the fields here.
type Listing = NonNullable<Awaited<ReturnType<typeof findListingById>>>;

// Title/body copy per type. The titles carry the keywords the in-app list keys
// its icon off of (see `notificationVisual` in the web app's
// notifications-model.ts): "confirm" → the confirmation glyph, and so on. Types
// with no natural UI category fall back to the generic bell.
const content: Record<
  InAppNotificationType,
  { title: string; body: (listingTitle: string) => string; isRead: boolean }
> = {
  notify_booking_update: {
    title: "Booking confirmed",
    body: (listing) => `There's an update on your booking for "${listing}".`,
    isRead: false,
  },
  notify_user: {
    title: "New notification",
    body: (listing) => `You have a new update related to "${listing}".`,
    isRead: false,
  },
  mark_as_read: {
    title: "Notification read",
    body: (listing) => `Your notification for "${listing}" was marked as read.`,
    isRead: true,
  },
};

// Pure: maps the queue payload + the already-resolved listing into the document
// shape. No I/O — the handler fetches and persists.
function buildNotification(
  payload: BookingNotificationPayload,
  listing: Listing,
): NotificationDocumentPayload {
  const copy = content[payload.type];
  return {
    event_id: payload.eventId,
    listing_id: listing._id, // The listing linked from listingsDb.listings
    host_id: listing.host_id,
    guest_id: payload.userId, // The user the notification is about
    booking_id: payload.bookingId,
    target_id: payload.userId, // The logged in user that should grab this notification
    title: copy.title,
    body: copy.body(listing.title),
    is_read: copy.isRead,
  };
}

export async function sendBookingNotification(
  payload: BookingNotificationPayload,
) {
  const [user, listing] = await Promise.all([
    findUserById(payload.userId),
    findListingById(payload.listingId),
  ]);
  if (!user || !listing) {
    throw new Error(
      "[sendBookingNotification]: Could not retrieve user or listing for the specified notification params",
    );
  }

  const notification = buildNotification(payload, listing);

  // Persist first (Mongo is the source of truth), then fan out. If the insert
  // fails we never publish, so a live client can't receive an event the DB
  // lacks — on refetch it would just vanish.
  //
  // El insert es también el claim: `false` es un reintento de un job ya
  // procesado, y republicar le duplicaría la notificación al cliente conectado.
  const inserted = await insertNotification(notification);
  if (!inserted) {
    console.info("[sendBookingNotification]: already stored for", payload.eventId);
    return;
  }

  await publish(
    channels.notifications(notification.target_id),
    JSON.stringify(notification),
  );
}
