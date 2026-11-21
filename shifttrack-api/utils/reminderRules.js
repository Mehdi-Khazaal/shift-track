// One reminder per stretch of work.
//
// In the app, back-to-back shifts at the same house show as one combined slot.
// Reminders follow the same idea: a shift that continues, at the same house, a
// shift ending at the exact minute it starts gets no reminder of its own. The
// employee is already there and is not going anywhere. The first shift of the
// stretch is reminded as usual.
//
// Shared by the 5-minute cron (scheduler.js) and the catch-up endpoint
// (routes/notifications.js send-upcoming) so the two paths always agree.
//
// When in doubt, remind: a predecessor on a day with approved leave, or a base
// shift that was cancelled, does not count, since it may not be worked.
'use strict';

// Deliberately imports nothing. utils/ppAnchor.js pulls in db/index.js, which
// connects and runs migrations on import, so even a unit test of this pure
// date logic would touch a database. This mirrors ppAnchor.payWeekOf exactly.
function payWeekOf(dateStr, anchorStr) {
  const anchor = new Date(anchorStr + 'T00:00:00');
  const d      = new Date(dateStr   + 'T00:00:00');
  const diff   = Math.round((d - anchor) / 86400000);
  return (((diff % 14) + 14) % 14) < 7 ? 1 : 2;
}

const ymd = d => String(d).slice(0, 10);
const dayNum = dateStr => {
  const [y, m, d] = ymd(dateStr).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};
const minutes = t => {
  const [h, m] = String(t).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};
const addDays = (dateStr, n) => {
  const d = new Date(ymd(dateStr) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Base schedule entries that actually happen on dateStr (not cancelled).
function baseOn(dateStr, baseRows, anchorStr, suppressed) {
  if (suppressed && suppressed.has(dateStr)) return [];
  const week = payWeekOf(dateStr, anchorStr);
  const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return (baseRows || [])
    .filter(b => Number(b.week) === week && Number(b.day_of_week) === dow)
    .map(b => ({ date: dateStr, start: b.start_time, end: b.end_time, locationId: b.location_id }));
}

//  target : { date, start, locationId } of the shift about to be reminded
//  ctx    : { logged, base, anchorStr, suppressed:Set<date>, leaveDates:Set<date> }
//           logged rows carry date/start_time/end_time/location_id, as from the DB
function continuesStretch(target, ctx) {
  if (!target || target.locationId == null) return false;
  const at = dayNum(target.date) * 1440 + minutes(target.start);
  const prev = addDays(target.date, -1);

  const candidates = [
    ...(ctx.logged || [])
      .filter(s => ymd(s.date) === ymd(target.date) || ymd(s.date) === prev)
      .map(s => ({ date: ymd(s.date), start: s.start_time, end: s.end_time, locationId: s.location_id })),
    ...baseOn(ymd(target.date), ctx.base, ctx.anchorStr, ctx.suppressed),
    ...baseOn(prev, ctx.base, ctx.anchorStr, ctx.suppressed),
  ];

  return candidates.some(c => {
    if (c.locationId !== target.locationId) return false;
    if (ctx.leaveDates && ctx.leaveDates.has(c.date)) return false;
    const s = dayNum(c.date) * 1440 + minutes(c.start);
    let e = dayNum(c.date) * 1440 + minutes(c.end);
    if (e <= s) e += 1440;
    return e === at;
  });
}

module.exports = { continuesStretch, baseOn };
