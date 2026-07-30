import { Job } from "bullmq";
import { resend } from "../resend.js";
import {
  BookingPayload,
  GreetingPayload,
  NotificationType,
} from "../events.js";
import { bookingEmailHtml } from "../templates/booking-email.js";
import { greetingEmailHtml } from "../templates/greeting-email.js";
import { createProcessor } from "./dispatch.js";
import * as eventsRepo from "../pg/events.pg.js";

const devMode = Number(process.env.DEV_MODE) === 1;

// Verified sender. dev uses Resend's sandbox address; prod sets a real domain.
const emailFrom = process.env.EMAIL_FROM ?? "onboarding@resend.dev";

// In dev every email is redirected here instead of the real recipient.
const devEmailTo = process.env.DEV_EMAIL_TO ?? "agustisera1@gmail.com";

// Resend no lanza ante un envío rechazado: resuelve a `{ data, error }`. Sin este
// throw el job resuelve OK y BullMQ lo marca completed, así que nunca reintenta.
async function sendEmail(
  label: string,
  options: Parameters<typeof resend.emails.send>[0],
) {
  const { data, error } = await resend.emails.send(options);

  if (error) {
    console.error(`[${label}]: send rejected by Resend`, error);
    // Error real, no el objeto plano de Resend: BullMQ lee `failedReason` de `.message`.
    throw new Error(`[${label}]: ${error.message}`, { cause: error });
  }

  console.info(`[${label}]: sent`, data?.id);
}

async function greetUser(job: Job) {
  const payload = job.data as GreetingPayload;

  const claimed = await eventsRepo.insertEvent(
    payload.eventId,
    payload.processorKey,
  );
  if (!claimed) {
    console.info("[greetUser]: already sent for", payload.eventId);
    return;
  }

  await sendEmail("greetUser", {
    from: emailFrom,
    to: devMode ? devEmailTo : [payload.email], // Just signed up email
    subject: "Welcome to bookings app!",
    html: greetingEmailHtml(payload),
  });
}

const subjects: Record<NotificationType, string> = {
  approved: "Reservation approved",
  pending: "Reservation pending",
  rejected: "Reservation rejected",
  updated: "Reservation updated",
  cancelled: "Reservation cancelled",
};

function getEmailNotificationPayload(data: BookingPayload) {
  return {
    subject: `${subjects[data.type]}: ${data.listing.title}`,
    html: bookingEmailHtml(data, data.type),
  };
}

// Every booking email flows through here; `payload.type` selects the lifecycle
// copy (pending / approved / rejected / updated).
async function notifyBooking(job: Job) {
  const payload = job.data as BookingPayload;

  const claimed = await eventsRepo.insertEvent(
    payload.eventId,
    payload.processorKey,
  );
  if (!claimed) {
    console.info("[notifyBooking]: already sent for", payload.eventId);
    return;
  }

  await sendEmail("notifyBooking", {
    from: emailFrom,
    to: devMode ? devEmailTo : [payload.guest.email],
    ...getEmailNotificationPayload(payload),
  });
}

// Consumes the "emails" queue. Only email jobs are registered here.
export const emailsProcessor = createProcessor("emailsProcessor", {
  "greet-user": greetUser,
  "notify-booking": notifyBooking,
});
