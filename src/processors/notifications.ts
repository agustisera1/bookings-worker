import type { Job } from "bullmq";
import type { NotificationJob } from "../events.js";
import { sendBookingNotification } from "../notifications/booking.js";

// Índice de la cola "notifications": el único lugar donde un processorKey se
// resuelve a su handler. El `never` del default es lo que vuelve exhaustivo al
// switch — sumar un job a `NotificationJob` sin su `case` deja de compilar.
export async function notificationsProcessor(job: Job) {
  const payload = job.data as NotificationJob;

  switch (payload.processorKey) {
    case "send-notification":
      return sendBookingNotification(payload);
    default: {
      // Con un solo miembro en la unión, el que narrowea a `never` es el
      // discriminante y no el payload — al revés que en emails.ts, que ya tiene
      // dos. Sumar un job a `NotificationJob` sin su `case` rompe esta línea.
      const unhandled: never = payload.processorKey;
      throw new Error(
        `[notificationsProcessor]: unknown processorKey ${unhandled}`,
      );
    }
  }
}
