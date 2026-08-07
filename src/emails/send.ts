import { resend } from "../resend.js";

const devMode = Number(process.env.DEV_MODE) === 1;

// Verified sender. dev uses Resend's sandbox address; prod sets a real domain.
const emailFrom = process.env.EMAIL_FROM ?? "onboarding@resend.dev";

// In dev every email is redirected here instead of the real recipient.
const devEmailTo = process.env.DEV_EMAIL_TO ?? "agustisera1@gmail.com";

type Email = { to: string; subject: string; html: string };

// Resend no lanza ante un envío rechazado: resuelve a `{ data, error }`. Sin este
// throw el job resuelve OK y BullMQ lo marca completed, así que nunca reintenta.
export async function sendEmail(label: string, { to, subject, html }: Email) {
  const { data, error } = await resend.emails.send({
    from: emailFrom,
    to: devMode ? devEmailTo : [to],
    subject,
    html,
  });

  if (error) {
    console.error(`[${label}]: send rejected by Resend`, error);
    // Error real, no el objeto plano de Resend: BullMQ lee `failedReason` de `.message`.
    throw new Error(`[${label}]: ${error.message}`, { cause: error });
  }

  console.info(`[${label}]: sent`, data?.id);
}
