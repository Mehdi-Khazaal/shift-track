// Pay-period date helpers and sandbox constants.
//
// Deliberately free of any database import. Requiring db/index.js kicks off
// migrate() as an import side effect, so a test that only wants a date helper
// must not reach it — otherwise a migration races the schema drop in setup.
'use strict';

const PP_ANCHOR = '2026-03-22'; // pay period 0 starts here (a Sunday)
const PASSWORD  = 'localdev123';

// Pay period N covers anchor+14N .. anchor+14N+13.
function ppDay(period, dayOffset) {
  const d = new Date(PP_ANCHOR + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + period * 14 + dayOffset);
  return d.toISOString().slice(0, 10);
}

module.exports = { PP_ANCHOR, PASSWORD, ppDay };
