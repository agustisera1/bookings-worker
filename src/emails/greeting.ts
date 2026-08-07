import type { GreetingPayload } from "../events.js";
import * as eventsRepo from "../pg/events.pg.js";
import { sendEmail } from "./send.js";

// The welcome email, end to end: the handler the "emails" queue routes to and
// the template it renders.

export async function greetUser(payload: GreetingPayload) {
  const claimed = await eventsRepo.insertEvent(
    payload.eventId,
    payload.processorKey,
  );
  if (!claimed) {
    console.info("[greetUser]: already sent for", payload.eventId);
    return;
  }

  await sendEmail("greetUser", {
    to: payload.email, // Just signed up email
    subject: "Welcome to bookings app!",
    html: greetingEmailHtml(payload),
  });
}

// Sent once when a user signs up. Shares the monochrome shell of the booking
// template but keeps the body minimal — just a greeting.
function greetingEmailHtml({ email }: GreetingPayload) {
  const userName = email.split("@")[0];

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Welcome</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f4f4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#111111;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background-color:#ffffff;border:1px solid #111111;">
            <!-- Header -->
            <tr>
              <td style="background-color:#111111;padding:28px 40px;">
                <h1 style="margin:0;font-size:20px;letter-spacing:2px;text-transform:uppercase;color:#ffffff;font-weight:600;">Welcome Aboard</h1>
              </td>
            </tr>

            <!-- Intro -->
            <tr>
              <td style="padding:40px 40px 32px 40px;">
                <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;">Hi ${userName},</p>
                <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:#333333;">
                  Thanks for joining us. Your account is all set — you can now browse listings, book your next stay and manage your reservations from one place.
                </p>
                <p style="margin:0;font-size:16px;line-height:1.6;color:#333333;">
                  We're glad to have you here.
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background-color:#f4f4f4;padding:24px 40px;border-top:1px solid #dddddd;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#999999;">
                  This is an automated message. Please do not reply directly to this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
