// Sends a notification email via Resend (resend.com — free tier, no card required).
// If RESEND_API_KEY isn't set, this quietly no-ops and logs to the console instead —
// so local development and testing never require real email credentials, and a
// misconfigured key never blocks a real submission from saving.

const NOTIFY_TO = process.env.NOTIFY_EMAIL || 'contact@the2sellers.io';
const FROM_ADDRESS = process.env.RESEND_FROM || 'The2Sellers.io <onboarding@resend.dev>';

async function sendNotification(subject, textBody) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log('[email skipped — no RESEND_API_KEY set] Subject:', subject);
    return { skipped: true };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [NOTIFY_TO],
        subject: subject,
        text: textBody
      })
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error('Email send failed:', res.status, errBody);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    // Never let an email failure break the actual submission — just log it.
    console.error('Email send threw an error:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendNotification };
