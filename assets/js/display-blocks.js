// ═══════════════════════════════════════════════════════════════════════════
//  DISPLAY BLOCKS
//
//  Back-to-back shifts at the same house are shown as one combined slot in
//  the employee app. This is DISPLAY ONLY. Every part stays its own shift:
//  its own id, edit permission, pay row, badges and notes. Nothing here may
//  feed into pay. The pay engine already has its own chain rule (any house,
//  paid in the week the chain starts) and is not affected by this file.
//
//  Commit 6286013 once merged such shifts by absorbing the second one into the
//  first, which made it impossible to edit; bf7f5c9 removed that. This
//  replaces it with grouping that keeps every part.
//
//  Rules:
//    - Two parts join when one ends at the exact minute the next starts, at
//      the same location. A one-minute gap, an overlap or another house never
//      joins.
//    - Any mix of base and logged shifts, any number of parts.
//    - When two parts start (or end) at the same house and minute, the link
//      is ambiguous and nothing joins there, rather than risk grouping the
//      wrong pair.
//    - Inputs are never modified. Blocks are recomputed on every render, so
//      editing one part so it no longer touches simply splits the block.
//
//  Loaded after pay-engine.js, and require()-able from the Node test suite.
// ═══════════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  const PE = root.PayEngine || (typeof require === 'function' ? require('./pay-engine.js') : null);

  // Stable identity for one part. A base schedule entry repeats every two
  // weeks under the same id, so its occurrence date is part of its identity.
  function partKey(p) {
    return p.isBase ? `base:${p.id}:${String(p.date).slice(0, 10)}` : `logged:${p.id}`;
  }

  function build(parts) {
    const items = [];
    for (const p of parts || []) {
      if (!p || !p.date) continue;
      const valid = PE.parseTime(p.start) != null && PE.parseTime(p.end) != null;
      const r = PE.absRange({ date: p.date, start: p.start, end: p.end });
      items.push({ p, key: partKey(p), start: r.start, end: r.end, loc: p.locationId, valid });
    }
    // Chronological; at the same minute, base before logged, then by key, so
    // the result never depends on input order.
    items.sort((a, b) =>
      a.start - b.start ||
      (a.p.isBase === b.p.isBase ? 0 : a.p.isBase ? -1 : 1) ||
      a.key.localeCompare(b.key));

    const at = (loc, t) => `${loc}@${t}`;
    const startsAt = new Map();
    for (const x of items) {
      if (!x.valid || x.loc == null) continue;
      const k = at(x.loc, x.start);
      startsAt.set(k, (startsAt.get(k) || 0) + 1);
    }

    const blocks = [];
    const openByEnd = new Map();     // "loc@endMinute" -> block that ends there
    const ambiguousEnd = new Set();  // two blocks end at the same house and minute

    for (const x of items) {
      let block = null;
      if (x.valid && x.loc != null) {
        const k = at(x.loc, x.start);
        if (startsAt.get(k) === 1 && !ambiguousEnd.has(k) && openByEnd.has(k)) {
          block = openByEnd.get(k);
          openByEnd.delete(k);
        }
      }
      if (block) {
        block.parts.push(x.p);
        block.partKeys.push(x.key);
        block.endAbs = x.end;
      } else {
        block = { parts: [x.p], partKeys: [x.key], startAbs: x.start, endAbs: x.end, locationId: x.loc, joinable: x.valid && x.loc != null };
        blocks.push(block);
      }
      if (block.joinable) {
        const ek = at(block.locationId, block.endAbs);
        if (openByEnd.has(ek) && openByEnd.get(ek) !== block) ambiguousEnd.add(ek);
        else openByEnd.set(ek, block);
      }
    }

    return blocks.map(b => {
      const first = b.parts[0], last = b.parts[b.parts.length - 1];
      return {
        key: b.partKeys.join('|'),
        locationId: b.locationId,
        date: String(first.date).slice(0, 10),
        start: first.start,
        end: last.end,
        startAbs: b.startAbs,
        endAbs: b.endAbs,
        parts: b.parts,
        partKeys: b.partKeys,
        combined: b.parts.length > 1,
      };
    }).sort((a, b) => a.startAbs - b.startAbs);
  }

  // YYYY-MM-DD of the last minute a block covers (it may be a later day than
  // it started). PayEngine day numbers map one-to-one onto calendar dates.
  // A block ending exactly at midnight counts as ending on its last day.
  function endDate(block) {
    const day = Math.floor((block.endAbs - 1) / 1440);
    return new Date(day * 86400000).toISOString().slice(0, 10);
  }

  const DisplayBlocks = { build, partKey, endDate };

  root.DisplayBlocks = DisplayBlocks;
  if (typeof module !== 'undefined' && module.exports) module.exports = DisplayBlocks;
})(typeof globalThis !== 'undefined' ? globalThis : this);
