import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { material, sanToWords } from '../js/boardinfo.js';
import { openingFor } from '../js/openings.js';
import { clockState, parseTimeControl } from '../js/research.js';
import { readFileSync } from 'node:fs';

test('material and captured pieces', () => {
  const g = new Chess();
  for (const m of ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qxg2']) g.move(m);
  const m = material(g.board());
  assert.deepEqual(m.capturedBy.w, ['p']);
  assert.deepEqual(m.capturedBy.b, ['p', 'p']);
  assert.equal(m.diff, -1);
});

test('a promoted queen is not counted as a missing pawn twice', () => {
  const g = new Chess('4k3/8/8/8/8/8/8/QQ2K3 w - - 0 1'); // White: two queens, no pawns
  const m = material(g.board());
  assert.deepEqual(m.capturedBy.b.filter((t) => t === 'p').length, 7); // one pawn became the second queen
  assert.equal(m.diff, 18);
});

test('moves read aloud', () => {
  assert.equal(sanToWords('e4'), 'e4');
  assert.equal(sanToWords('Nf3'), 'Knight f3');
  assert.equal(sanToWords('exd5'), 'e takes d5');
  assert.equal(sanToWords('Nbd7'), 'Knight b d7'.replace(' b d7', ' b d7'));
  assert.equal(sanToWords('Qxf7#'), 'Queen takes f7, checkmate');
  assert.equal(sanToWords('O-O+'), 'castles kingside, check');
  assert.equal(sanToWords('e8=Q'), 'e8, promotes to Queen');
});

test('opening names', () => {
  const table = JSON.parse(readFileSync('vendor/openings.json', 'utf8'));
  const g = new Chess();
  const fens = [];
  for (const m of ['e4', 'c6', 'd4', 'd5', 'e5']) { g.move(m); fens.push(g.fen()); }
  const o = openingFor(fens, table);
  assert.equal(o.eco, 'B12');
  assert.match(o.name, /Caro-Kann Defense: Advance Variation/);
  // leaving book keeps the last named opening
  g.move('Bf5'); fens.push(g.fen()); g.move('a3'); fens.push(g.fen());
  assert.match(openingFor(fens, table).name, /Caro-Kann/);
});

test('chess clock from move times', () => {
  const tc = parseTimeControl('5+3');
  const meta = [{ emt: 10_000, at: 10_000 }, { emt: 20_000, at: 30_000 }];
  const c = clockState(meta, tc, 'w', 35_000, 0);
  assert.equal(c.w, 300_000 - 10_000 + 3000 - 5000);
  assert.equal(c.b, 300_000 - 20_000 + 3000);
  assert.equal(c.running, 'w');
  assert.equal(clockState([], null, 'w', 0, 0), null);
});
