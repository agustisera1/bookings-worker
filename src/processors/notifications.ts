import { Job } from "bullmq";
import { NotificationJobPayload } from "../events.js";
import { findListingById } from "../mongo/listings.mongo.js";
import { insertNotification } from "../mongo/notifications.mongo.js";
import { findUserById } from "../pg/users.pg.js";
import { channels, publish } from "../redis/client.js";
import { buildNotification } from "../notifications/build-notification.js";
import { createProcessor } from "./dispatch.js";

async function sendNotification(job: Job) {
  const payload = job.data as NotificationJobPayload;
  const [user, listing] = await Promise.all([
    findUserById(payload.userId),
    findListingById(payload.listingId),
  ]);
  if (!user || !listing) {
    throw new Error(
      "[sendNotification]: Could not retrieve user or listing for the specified notification params",
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
    console.info("[sendNotification]: already stored for", payload.eventId);
    return;
  }

  await publish(
    channels.notifications(notification.target_id),
    JSON.stringify(notification),
  );
}

// Consumes the "notifications" queue. Only notification jobs are registered here.
export const notificationsProcessor = createProcessor("notificationsProcessor", {
  "send-notification": sendNotification,
});
