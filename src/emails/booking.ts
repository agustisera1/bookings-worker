import type { Booking, BookingPayload, NotificationType } from "../events.js";
import { formatDate, nightsBetween } from "../dates.js";
import { formatAddress, formatMoney } from "../utils.js";
import * as eventsRepo from "../pg/events.pg.js";
import { sendEmail } from "./send.js";

// The booking email, end to end: the handler the "emails" queue routes to, its
// subject lines and the template it renders. Every booking email flows through
// here; `payload.type` selects the lifecycle copy.

const subjects: Record<NotificationType, string> = {
  approved: "Reservation approved",
  pending: "Reservation pending",
  rejected: "Reservation rejected",
  updated: "Reservation updated",
  cancelled: "Reservation cancelled",
};

export async function notifyBooking(payload: BookingPayload) {
  const claimed = await eventsRepo.insertEvent(
    payload.eventId,
    payload.processorKey,
  );
  if (!claimed) {
    console.info("[notifyBooking]: already sent for", payload.eventId);
    return;
  }

  await sendEmail("notifyBooking", {
    to: payload.guest.email,
    subject: `${subjects[payload.type]}: ${payload.listing.title}`,
    html: bookingEmailHtml(payload, payload.type),
  });
}

// Per-type copy. Kept intentionally simple: only the header, status pill and
// intro paragraph change; the booking detail grid is shared across all types.
const notificationCopy: Record<
  NotificationType,
  {
    heading: string;
    status: string;
    intro: (host: string, booking: Booking) => string;
  }
> = {
  pending: {
    heading: "Booking Received",
    status: "Status: Pending confirmation",
    intro: (host) =>
      `Your reservation is being processed. We'll notify you as soon as <strong>${host}</strong> verifies the payment and details to confirm your stay.`,
  },
  approved: {
    heading: "Booking Confirmed",
    status: "Status: Approved",
    intro: (host) =>
      `Great news — <strong>${host}</strong> has confirmed your reservation. Your stay is all set.`,
  },
  rejected: {
    heading: "Booking Declined",
    status: "Status: Rejected",
    intro: (host) =>
      `Unfortunately, <strong>${host}</strong> could not confirm your reservation. Any payment made will be refunded.`,
  },
  updated: {
    heading: "Booking Updated",
    status: "Status: Updated",
    intro: (host) =>
      `Your reservation details have been updated by <strong>${host}</strong>. Please review the information below.`,
  },
  // Always addressed to the guest, but the copy turns on who cancelled: a host
  // cancelling is an apology, a guest cancelling is a receipt. Says the refund
  // amount without explaining the rule behind it — that rule lives in the app's
  // cancellation policy, and restating it here is how the two drift apart.
  cancelled: {
    heading: "Booking Cancelled",
    status: "Status: Cancelled",
    intro: (host, booking) => {
      const refund = booking.refundAmount ?? 0;
      const refundLine =
        refund > 0
          ? `A refund of <strong>${formatMoney(refund)}</strong> will be issued.`
          : "This booking is not eligible for a refund.";

      return booking.cancelledBy === "host"
        ? `<strong>${host}</strong> has cancelled your reservation, and we're sorry for the disruption. ${refundLine}`
        : `Your cancellation is confirmed. ${refundLine}`;
    },
  },
};

function bookingEmailHtml(
  { guest, booking, host, listing }: BookingPayload,
  type: NotificationType = "updated",
) {
  const nights = nightsBetween(booking.checkIn, booking.checkOut);
  const total = formatMoney(booking.totalPrice);

  const guestName = guest.email.split("@")[0];
  const propertyAddress = formatAddress(listing.location);
  const copy = notificationCopy[type];

  // Optional note explaining an approval, rejection or cancellation. Only
  // rendered for those types, and only when the app supplied a reason.
  const reasonLabel =
    type === "approved"
      ? "Note from host"
      : type === "rejected"
        ? "Reason for decline"
        : type === "cancelled"
          ? "Reason for cancellation"
          : null;
  const reasonBlock =
    reasonLabel && booking.statusReason
      ? `
            <!-- Status reason -->
            <tr>
              <td style="padding:0 40px 32px 40px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid #111111;background-color:#f4f4f4;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 4px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#888888;">${reasonLabel}</p>
                      <p style="margin:0;font-size:15px;line-height:1.6;color:#333333;">${booking.statusReason}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`
      : "";

  // On a cancellation the total already paid is no longer the number that
  // matters, so the refund gets its own block right under it. Skipped when
  // there's nothing to refund: the intro already says so, and a $0.00 box reads
  // like a bug.
  const refundAmount = booking.refundAmount ?? 0;
  const refundBlock =
    type === "cancelled" && refundAmount > 0
      ? `
            <!-- Refund -->
            <tr>
              <td style="padding:0 40px 32px 40px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #111111;">
                  <tr>
                    <td style="padding:20px 24px;">
                      <p style="margin:0 0 4px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#888888;">Refund</p>
                      <p style="margin:0;font-size:24px;font-weight:700;color:#111111;">${formatMoney(refundAmount)}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${copy.heading}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f4f4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#111111;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background-color:#ffffff;border:1px solid #111111;">
            <!-- Header -->
            <tr>
              <td style="background-color:#111111;padding:28px 40px;">
                <h1 style="margin:0;font-size:20px;letter-spacing:2px;text-transform:uppercase;color:#ffffff;font-weight:600;">${copy.heading}</h1>
              </td>
            </tr>

            <!-- Intro -->
            <tr>
              <td style="padding:40px 40px 24px 40px;">
                <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;">Hi ${guestName},</p>
                <p style="margin:0;font-size:16px;line-height:1.6;color:#333333;">
                  ${copy.intro(host.name, booking)}
                </p>
              </td>
            </tr>

            <!-- Status pill -->
            <tr>
              <td style="padding:0 40px 32px 40px;">
                <span style="display:inline-block;padding:8px 16px;border:1px solid #111111;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#111111;">${copy.status}</span>
              </td>
            </tr>
${reasonBlock}
            <!-- Property -->
            <tr>
              <td style="padding:0 40px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #dddddd;border-bottom:1px solid #dddddd;">
                  <tr>
                    <td style="padding:24px 0;">
                      <p style="margin:0 0 4px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#888888;">Property</p>
                      <p style="margin:0;font-size:18px;font-weight:600;color:#111111;">${listing.title}</p>
                      <p style="margin:4px 0 0 0;font-size:14px;color:#555555;">${propertyAddress}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Dates grid -->
            <tr>
              <td style="padding:0 40px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td width="50%" style="padding:24px 16px 24px 0;border-bottom:1px solid #dddddd;vertical-align:top;">
                      <p style="margin:0 0 4px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#888888;">Check-in</p>
                      <p style="margin:0;font-size:16px;font-weight:600;color:#111111;">${formatDate(booking.checkIn)}</p>
                    </td>
                    <td width="50%" style="padding:24px 0 24px 16px;border-bottom:1px solid #dddddd;border-left:1px solid #dddddd;vertical-align:top;">
                      <p style="margin:0 0 4px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#888888;">Check-out</p>
                      <p style="margin:0;font-size:16px;font-weight:600;color:#111111;">${formatDate(booking.checkOut)}</p>
                    </td>
                  </tr>
                  <tr>
                    <td width="50%" style="padding:24px 16px 24px 0;border-bottom:1px solid #dddddd;vertical-align:top;">
                      <p style="margin:0 0 4px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#888888;">Nights</p>
                      <p style="margin:0;font-size:16px;font-weight:600;color:#111111;">${nights}</p>
                    </td>
                    <td width="50%" style="padding:24px 0 24px 16px;border-bottom:1px solid #dddddd;border-left:1px solid #dddddd;vertical-align:top;">
                      <p style="margin:0 0 4px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#888888;">Guests</p>
                      <p style="margin:0;font-size:16px;font-weight:600;color:#111111;">${booking.guests}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Total -->
            <tr>
              <td style="padding:32px 40px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#111111;">
                  <tr>
                    <td style="padding:20px 24px;">
                      <p style="margin:0 0 4px 0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#aaaaaa;">Total</p>
                      <p style="margin:0;font-size:24px;font-weight:700;color:#ffffff;">${total}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
${refundBlock}
            <!-- Reference -->
            <tr>
              <td style="padding:0 40px 40px 40px;">
                <p style="margin:0;font-size:13px;color:#888888;">
                  Booking reference: <span style="color:#111111;font-family:'Courier New',monospace;letter-spacing:1px;">${booking.id}</span>
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
