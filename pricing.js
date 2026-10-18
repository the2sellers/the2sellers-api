// Ticket pricing: an optional early-bird price that applies until a set moment,
// after which the standard price applies automatically. One place decides the
// price so the event page, checkout, free-booking check and emails always agree.

function earlyActive(ev, now) {
  if (!ev) return false;
  const p = ev.early_price_cents;
  if (p === null || p === undefined || !ev.early_until) return false;
  const until = new Date(ev.early_until).getTime();
  if (!until || Number.isNaN(until)) return false;
  return (now || Date.now()) < until;
}

function currentTicketCents(ev, now) {
  return earlyActive(ev, now) ? ev.early_price_cents : (ev.ticket_price_cents || 0);
}

module.exports = { earlyActive, currentTicketCents };
