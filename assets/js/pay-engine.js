// ═══════════════════════════════════════════════════════════════════════════
//  SHARED PAY / OT ENGINE
//
//  One rulebook for every surface that shows money or hours: the employee
//  dashboard, the week groups, the pay-history cards, the printed PDF, and both
//  admin views. Before this existed each of those computed the same thing
//  slightly differently — the PDF omitted the block premium and call-off
//  deductions, the admin views omitted pull bonuses and hardcoded a 40h
//  threshold, and the dashboard header and the rows beneath it were two
//  separate computations that could not agree.
//
//  Extracted for the same reason shifttrack-api/utils/shiftRules.js was: one
//  implementation, many callers, no drift.
//
//  Loaded as a plain <script> before index.js / admin.js, and require()-able
//  from the Node test suite via the shim at the bottom.
// ═══════════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  const BLOCK_PREMIUM = 0.50;   // per hour, base shifts only, 'block' workers
  const OT_MULTIPLIER = 1.5;

  // ── Time primitives ──────────────────────────────────────────────────────
  // Accepts 07:00, 7:00, 15:00:00, 3:00 PM. Mirrors parseTimeString in index.js.
  function parseTime(t) {
    if (!t) return null;
    const m = String(t).trim().toUpperCase().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (m[3] === 'AM' && h === 12) h = 0;
    else if (m[3] === 'PM' && h !== 12) h += 12;
    return h * 60 + min;
  }

  // Hours between two times, rolling past midnight when end <= start.
  // Rounded to one decimal, matching the long-standing shiftHours() behaviour
  // in both frontends — kept identical so existing totals do not shift.
  function shiftHours(start, end) {
    const s = parseTime(start), e = parseTime(end);
    if (s == null || e == null) return 0;
    let mins = e - s;
    if (mins <= 0) mins += 1440;
    return Math.round((mins / 60) * 10) / 10;
  }

  // Whole days since epoch for a YYYY-MM-DD string, using local midnight so it
  // lines up with the rest of the app's date handling.
  function dayNumber(dateStr) {
    return Math.round(new Date(String(dateStr).slice(0, 10) + 'T00:00:00').getTime() / 86400000);
  }

  function addDays(dateStr, n) {
    const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  // Local-date YYYY-MM-DD. Not toISOString(), which converts to UTC and would
  // roll a local midnight back to the previous day east of Greenwich.
  function ymd(d) {
    if (!d || typeof d.getFullYear !== 'function') return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // The Sunday that opens the calendar week containing dateStr.
  function weekSundayOf(dateStr) {
    const d = new Date(String(dateStr).slice(0, 10) + 'T12:00:00');
    d.setDate(d.getDate() - d.getDay());
    return ymd(d);
  }

  // Absolute [start, end) in minutes since epoch, so overnight shifts compare
  // correctly against shifts on the adjacent day.
  function absRange(seg) {
    const base = dayNumber(seg.date) * 1440;
    const s = parseTime(seg.start) || 0;
    let e = parseTime(seg.end);
    if (e == null) e = s;
    if (e <= s) e += 1440;
    return { start: base + s, end: base + e };
  }

  // ── Late-night normalisation ─────────────────────────────────────────────
  // A shift punched in at 23:55–23:59 is really the next day's shift starting
  // at midnight. Introduced in 007dbe4; preserved verbatim. Display keeps the
  // original date and time — only pay/OT calculation sees this.
  function normalizeCalcShift(s) {
    const t = parseTime(s.start);
    if (t == null) return s;
    const h = Math.floor(t / 60), m = t % 60;
    if (h === 23 && m >= 55) {
      return Object.assign({}, s, { date: addDays(s.date, 1), start: '00:00' });
    }
    return s;
  }

  // ── Chains ───────────────────────────────────────────────────────────────
  // Shifts that touch exactly — one ends the minute the next begins — are one
  // continuous stretch of work, regardless of which house each leg is at.
  // The whole stretch is paid in the week its FIRST leg starts, so a Saturday
  // 22:00 → Sunday 08:00 shift followed by Sunday 08:00 → 16:00 belongs wholly
  // to the Saturday week and does not reappear in the Sunday week.
  //
  // Segments are deliberately NOT merged into one row: each keeps its own
  // location, rate and times, so a cross-house chain pays each leg at its own
  // house's rate and the PDF shows the shifts that were actually worked.
  function buildChains(segments) {
    const withAbs = segments.map(s => {
      const r = absRange(s);
      return Object.assign({}, s, { _absStart: r.start, _absEnd: r.end });
    });
    withAbs.sort((a, b) => a._absStart - b._absStart || String(a.id).localeCompare(String(b.id)));

    let chainStartDate = null;
    let chainEnd = null;
    for (const seg of withAbs) {
      if (chainEnd !== null && seg._absStart === chainEnd) {
        seg.chainStartDate = chainStartDate;          // links onto the running chain
        chainEnd = Math.max(chainEnd, seg._absEnd);
      } else {
        chainStartDate = seg.date;                    // starts a new chain
        seg.chainStartDate = chainStartDate;
        chainEnd = seg._absEnd;
      }
    }
    return withAbs;
  }

  // The week a segment is paid in: the week of its chain's first leg.
  function payWeekOf(seg) {
    return weekSundayOf(seg.chainStartDate || seg.date);
  }

  // Normalise, chain, and tag every segment with the week it is paid in.
  // Callers pass a window padded at least one day either side of the range they
  // care about, then filter on payWeek — never on the segment's own date.
  function prepare(segments) {
    return buildChains(segments.map(normalizeCalcShift)).map(s => {
      s.payWeek = payWeekOf(s);
      return s;
    });
  }

  // ── The OT engine ────────────────────────────────────────────────────────
  //  segments : prepared segments, already filtered to one pay week
  //  options  : { otThreshold, isBlock, rateOf, callOffHoursByDate }
  //
  //  rateOf(segment) resolves the base hourly rate. The employee app looks the
  //  location up in its cache; the admin app reads the rate denormalised onto
  //  the row — hence the injection rather than a hardcoded lookup.
  //
  //  Returns { rows, totalHrs, totalPay, totalOt } where every total is the sum
  //  over rows, so a header can never disagree with the rows beneath it.
  function computePay(segments, options) {
    const opts = options || {};
    const thresh = Number(opts.otThreshold) > 0 ? Number(opts.otThreshold) : 40;
    const isBlock = !!opts.isBlock;
    const rateOf = typeof opts.rateOf === 'function' ? opts.rateOf : () => 0;
    const callOffs = opts.callOffHoursByDate || {};

    const sorted = segments.slice().sort(
      (a, b) => (a._absStart != null && b._absStart != null)
        ? a._absStart - b._absStart
        : (String(a.date).localeCompare(String(b.date)) || String(a.start).localeCompare(String(b.start)))
    );

    // Approved call-off hours are unpaid. They are budgeted once per DATE and
    // drawn down across that day's shifts in order. Deducting the full figure
    // from every shift sharing the date (the old behaviour) double-subtracted
    // whenever someone worked twice in a day.
    const callOffRemaining = {};
    for (const d of Object.keys(callOffs)) callOffRemaining[d] = parseFloat(callOffs[d]) || 0;

    let regRunning = 0;
    const rows = sorted.map(s => {
      const rawHrs = shiftHours(s.start, s.end);

      const budget = callOffRemaining[s.date] || 0;
      const callOffHrs = Math.min(budget, rawHrs);
      if (budget) callOffRemaining[s.date] = budget - callOffHrs;

      const hrs = Math.max(0, rawHrs - callOffHrs);
      const blockPremium = (isBlock && s.isBase) ? BLOCK_PREMIUM : 0;
      const rate = (s.payRateOverride != null ? s.payRateOverride : rateOf(s)) + blockPremium;

      const regHrs = Math.max(0, Math.min(hrs, thresh - regRunning));
      const otHrs = hrs - regHrs;
      const pullBonus = s.pullBonus || 0;
      const pay = regHrs * rate + otHrs * rate * OT_MULTIPLIER + pullBonus;

      regRunning += regHrs;
      return Object.assign({}, s, { hrs, rawHrs, callOffHrs, regHrs, otHrs, rate, pullBonus, pay });
    });

    return {
      rows,
      totalHrs: rows.reduce((a, r) => a + r.hrs, 0),
      totalPay: rows.reduce((a, r) => a + r.pay, 0),
      totalOt:  rows.reduce((a, r) => a + r.otHrs, 0),
    };
  }

  // Collapse approved call-off leave requests into { 'YYYY-MM-DD': hours }.
  function callOffMap(leaveRequests) {
    const out = {};
    for (const r of leaveRequests || []) {
      if (r.type_name !== 'call_off' || r.status !== 'approved' || !r.date) continue;
      const d = String(r.date).slice(0, 10);
      out[d] = (out[d] || 0) + (parseFloat(r.hours_requested) || 0);
    }
    return out;
  }

  const PayEngine = {
    BLOCK_PREMIUM, OT_MULTIPLIER,
    parseTime, shiftHours, dayNumber, addDays, ymd, weekSundayOf, absRange,
    normalizeCalcShift, buildChains, payWeekOf, prepare, computePay, callOffMap,
  };

  root.PayEngine = PayEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = PayEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
