// Unit tests for display grouping of back-to-back shifts (assets/js/display-blocks.js).
//
// Display only: these blocks decide how shifts are SHOWN in the employee app.
// Pay is computed separately by the pay engine and must never depend on them.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

require(path.resolve(__dirname, '../../assets/js/pay-engine.js'));
const DisplayBlocks = require(path.resolve(__dirname, '../../assets/js/display-blocks.js'));

const HOUSE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const HOUSE_B = 'bbbbbbbb-0000-0000-0000-000000000002';

let seq = 0;
const logged = (date, start, end, extra) =>
  Object.assign({ id: `s${++seq}`, locationId: HOUSE_A, date, start, end, isBase: false }, extra || {});
const base = (date, start, end, extra) =>
  Object.assign({ id: `b${++seq}`, locationId: HOUSE_A, date, start, end, isBase: true }, extra || {});

const SAT = '2026-11-21', SUN = '2026-11-22';
const shapes = blocks => blocks.map(b => b.parts.map(p => p.id));

describe('which shifts combine', () => {
  test('two shifts that touch at the same house combine', () => {
    const a = logged(SUN, '08:00', '12:00'), b = logged(SUN, '12:00', '16:00');
    const blocks = DisplayBlocks.build([a, b]);
    assert.deepStrictEqual(shapes(blocks), [[a.id, b.id]]);
    assert.strictEqual(blocks[0].combined, true);
    assert.strictEqual(blocks[0].start, '08:00');
    assert.strictEqual(blocks[0].end, '16:00');
  });

  test('a different house never combines, even when the times touch', () => {
    const a = logged(SUN, '08:00', '12:00'), b = logged(SUN, '12:00', '16:00', { locationId: HOUSE_B });
    assert.deepStrictEqual(shapes(DisplayBlocks.build([a, b])), [[a.id], [b.id]]);
  });

  test('a one-minute gap does not combine', () => {
    const a = logged(SUN, '08:00', '12:00'), b = logged(SUN, '12:01', '16:00');
    assert.deepStrictEqual(shapes(DisplayBlocks.build([a, b])), [[a.id], [b.id]]);
  });

  test('overlapping shifts do not combine', () => {
    const a = logged(SUN, '08:00', '12:30'), b = logged(SUN, '12:00', '16:00');
    assert.deepStrictEqual(shapes(DisplayBlocks.build([a, b])), [[a.id], [b.id]]);
  });

  test('a base shift followed by an added shift combines across midnight', () => {
    const night = base(SAT, '22:00', '08:00'), morning = logged(SUN, '08:00', '16:00');
    const [blk] = DisplayBlocks.build([morning, night]);
    assert.deepStrictEqual(blk.parts.map(p => p.id), [night.id, morning.id]);
    assert.strictEqual(blk.date, SAT);
    assert.strictEqual(DisplayBlocks.endDate(blk), SUN);
  });

  test('three or more parts, base + logged + base, form one block in order', () => {
    const p1 = base(SUN, '00:00', '08:00'), p2 = logged(SUN, '08:00', '16:00'), p3 = base(SUN, '16:00', '23:00');
    assert.deepStrictEqual(shapes(DisplayBlocks.build([p3, p1, p2])), [[p1.id, p2.id, p3.id]]);
  });

  test('a shift at another house in between does not break a same-house chain', () => {
    const a = logged(SUN, '06:00', '10:00');
    const other = logged(SUN, '07:00', '09:00', { locationId: HOUSE_B });
    const b = logged(SUN, '10:00', '12:00');
    const blocks = DisplayBlocks.build([a, other, b]);
    assert.deepStrictEqual(shapes(blocks), [[a.id, b.id], [other.id]]);
  });

  test('when two shifts start at the same house and minute, nothing joins there', () => {
    const a = logged(SUN, '08:00', '12:00');
    const dup1 = logged(SUN, '12:00', '14:00'), dup2 = logged(SUN, '12:00', '16:00');
    const blocks = DisplayBlocks.build([a, dup1, dup2]);
    assert.ok(blocks.every(b => !b.combined), 'ambiguous link must not group');
    assert.strictEqual(blocks.length, 3);
  });

  test('a shift with an unreadable time stays on its own', () => {
    const a = logged(SUN, '08:00', '12:00'), bad = logged(SUN, 'nonsense', '16:00');
    const blocks = DisplayBlocks.build([a, bad]);
    assert.ok(blocks.every(b => !b.combined));
  });
});

describe('what a block keeps', () => {
  test('single shifts come back as one-part blocks', () => {
    const a = logged(SUN, '08:00', '12:00');
    const [blk] = DisplayBlocks.build([a]);
    assert.strictEqual(blk.combined, false);
    assert.strictEqual(blk.parts[0], a, 'the original object, not a copy');
  });

  test('every part is the original object, with all its fields', () => {
    const night = base(SAT, '22:00', '08:00', { pay: 235, hrs: 10, notes: 'n' });
    const morning = logged(SUN, '08:00', '16:00', { pay: 276, hrs: 8, otHrs: 8, locked: true });
    const [blk] = DisplayBlocks.build([night, morning]);
    assert.strictEqual(blk.parts[0], night);
    assert.strictEqual(blk.parts[1], morning);
    assert.strictEqual(blk.parts[1].locked, true);
  });

  test('inputs are never modified', () => {
    const a = logged(SUN, '08:00', '12:00'), b = logged(SUN, '12:00', '16:00');
    const before = JSON.stringify([a, b]);
    DisplayBlocks.build([a, b]);
    assert.strictEqual(JSON.stringify([a, b]), before);
  });

  test('a base part is identified by its date as well, since base slots repeat', () => {
    const w1 = base('2026-11-08', '22:00', '08:00', { id: 'same' });
    const w3 = base('2026-11-22', '22:00', '08:00', { id: 'same' });
    const keys = DisplayBlocks.build([w1, w3]).map(b => b.key);
    assert.deepStrictEqual(keys, ['base:same:2026-11-08', 'base:same:2026-11-22']);
  });

  test('the result does not depend on input order', () => {
    const p1 = base(SAT, '22:00', '08:00'), p2 = logged(SUN, '08:00', '16:00'), p3 = logged(SUN, '20:00', '22:00');
    const a = DisplayBlocks.build([p1, p2, p3]).map(b => b.key);
    const b = DisplayBlocks.build([p3, p2, p1]).map(b => b.key);
    assert.deepStrictEqual(a, b);
  });

  test('a block ending exactly at midnight ends on its own day', () => {
    const a = logged(SAT, '16:00', '20:00'), b = logged(SAT, '20:00', '00:00');
    const [blk] = DisplayBlocks.build([a, b]);
    assert.strictEqual(DisplayBlocks.endDate(blk), SAT);
  });
});
