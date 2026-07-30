import { NotificationJobPayload } from "../events.js";
import { findListingById } from "../mongo/listings.mongo.js";
import { NotificationDocumentPayload } from "../mongo/notifications.mongo.js";
import { notificationContent } from "./content.js";

// The listing shape findListingById returns (a Mongo doc with a stringified
// _id). Derived from the repository so it stays in step with what that actually
// hands back, instead of re-declaring the fields here.
type Listing = NonNullable<Awaited<ReturnType<typeof findListingById>>>;

// Pure: assembles the notification row to persist from the queue payload and the
// already-resolved listing. No I/O — the processor fetches and persists; this
// only maps the copy + ids into the document shape.
export function buildNotification(
  payload: NotificationJobPayload,
  listing: Listing,
): NotificationDocumentPayload {
  const content = notificationContent[payload.type];
  return {
    event_id: payload.eventId,
    listing_id: listing._id, // The listing linked from listingsDb.listings
    host_id: listing.host_id,
    guest_id: payload.userId, // The user the notification is about
    booking_id: payload.bookingId,
    target_id: payload.userId, // The logged in user that should grab this notification
    title: content.title,
    body: content.body(listing.title),
    is_read: content.isRead,
  };
}
