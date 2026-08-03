import { MongoServerError, WithId } from "mongodb";
import mongo from "./index.js";

export type NotificationDocumentPayload = {
  // Idempotency key: fila de `outbox` que originó el job. Cubierta por un unique
  // index, así que acá el guard y el efecto son el mismo insert.
  event_id: string;
  listing_id: string;
  host_id: string;
  guest_id: string;
  booking_id: string;
  target_id: string;
  title: string;
  body: string;
  is_read: boolean;
};

export type NotificationDocument = WithId<NotificationDocumentPayload>;

async function getCollection() {
  const client = await mongo;
  return client
    .db("notificationsdb")
    .collection<NotificationDocumentPayload>("notifications");
}

/**
 * `false` = ya había una notificación para ese evento, o sea que otro intento
 * del mismo job la escribió. Cualquier otra falla propaga para que BullMQ
 * reintente.
 */
export async function insertNotification(
  notification: NotificationDocumentPayload,
): Promise<boolean> {
  const collection = await getCollection();

  try {
    const { insertedId } = await collection.insertOne(notification);
    return Boolean(insertedId);
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return false;
    throw error;
  }
}
