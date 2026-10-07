// Sends email via Resend (resend.com).
// If RESEND_API_KEY isn't set, this quietly no-ops and logs to the console instead,
// so local development and testing never require real email credentials, and a
// misconfigured key never blocks a real submission or booking from saving.
//
// NOTIFY_EMAIL: where owner notifications go (defaults to contact@the2sellers.io).
// RESEND_FROM:  sender for owner notifications (unchanged; works with Resend's shared sender).
// TICKET_FROM:  sender for emails to customers (tickets). This must be an address on a domain
//               verified in Resend. Defaults to "The2Sellers.io <tickets@the2sellers.io>", so
//               ticket emails start working as soon as the2sellers.io is verified in Resend.

const NOTIFY_TO = process.env.NOTIFY_EMAIL || 'contact@the2sellers.io';
const FROM_ADDRESS = process.env.RESEND_FROM || 'The2Sellers.io <onboarding@resend.dev>';
const TICKET_FROM = process.env.TICKET_FROM || 'The2Sellers.io <tickets@the2sellers.io>';
const REPLY_TO = process.env.REPLY_TO_EMAIL || 'contact@the2sellers.io';

async function postToResend(payload) {
  const apiKey = process.env.RESEND_API_KEY;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error('Email send failed:', res.status, errBody);
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

// Owner notification (plain text, optional attachments). Unchanged behaviour.
async function sendNotification(subject, textBody, attachments) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[email skipped — no RESEND_API_KEY set] Subject:', subject);
    return { skipped: true };
  }
  try {
    const payload = {
      from: FROM_ADDRESS,
      to: [NOTIFY_TO],
      subject: subject,
      text: textBody
    };
    if (attachments && attachments.length > 0) {
      payload.attachments = attachments.map(function(a) {
        return { filename: a.filename, content: a.content };
      });
    }
    return await postToResend(payload);
  } catch (err) {
    // Never let an email failure break the actual submission — just log it.
    console.error('Email send threw an error:', err.message);
    return { ok: false, error: err.message };
  }
}

// Email to a customer (HTML plus a plain-text copy).
async function sendMail(opts) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[email skipped — no RESEND_API_KEY set] To:', opts.to, 'Subject:', opts.subject);
    return { skipped: true };
  }
  try {
    const payload = {
      from: TICKET_FROM,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      reply_to: opts.replyTo || REPLY_TO
    };
    return await postToResend(payload);
  } catch (err) {
    console.error('Email send threw an error:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendNotification, sendMail, TICKET_FROM, NOTIFY_TO, FROM_ADDRESS };
