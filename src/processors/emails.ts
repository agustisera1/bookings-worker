import type { Job } from "bullmq";
import type { EmailJob } from "../events.js";
import { notifyBooking } from "../emails/booking.js";
import { greetUser } from "../emails/greeting.js";

// Índice de la cola "emails": el único lugar donde un processorKey se resuelve a
// su handler. El `never` del default es lo que vuelve exhaustivo al switch —
// sumar un job a `EmailJob` sin darle su `case` deja de compilar.
export async function emailsProcessor(job: Job) {
  const payload = job.data as EmailJob;

  switch (payload.processorKey) {
    case "notify-booking":
      return notifyBooking(payload);
    case "greet-user":
      return greetUser(payload);
    default: {
      // Cubiertos todos los miembros de la unión, `payload` queda en `never`:
      // sumar un job a `EmailJob` sin su `case` rompe esta asignación.
      const unhandled: never = payload;
      void unhandled;
      throw new Error(
        `[emailsProcessor]: unknown processorKey ${job.data.processorKey}`,
      );
    }
  }
}
