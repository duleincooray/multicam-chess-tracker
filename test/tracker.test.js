import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { inferMove, touchedSquares, sqIndex, sqName, buildPgn } from '../js/tracker.js';

const scoresFor = (map) => {
  const s = new Float32Array(64);
  for (const [sq, v] of Object.entries(map)) s[sqIndex(sq)] = v;
  return s;
};

test('square names and indexes round-trip', () => {
  assert.equal(sqIndex('a1'), 0);
  assert.equal(sqIndex('h1'), 7);
  assert.equal(sqIndex('a8'), 56);
  for (let i = 0; i < 64; i++) assert.equal(sqIndex(sqName(i)), i);
});

test('no change gives no move', () => {
  assert.equal(inferMove(new Chess(), new Float32Array(64)).status, 'none');
});

test('pawn push is found despite occlusion bleed onto nearby squares', () => {
  const r = inferMove(new Chess(), scoresFor({ e2: 0.8, e4: 0.7, e3: 0.35, e5: 0.2, e1: 0.1 }));
  assert.equal(r.status, 'move');
  assert.equal(r.move.san, 'e4');
});

test('knight move', () => {
  const r = inferMove(new Chess(), scoresFor({ g1: 0.7, f3: 0.6 }));
  assert.equal(r.move.san, 'Nf3');
});

test('kingside castling needs all four squares', () => {
  const g = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const r = inferMove(g, scoresFor({ e1: 0.6, g1: 0.6, h1: 0.6, f1: 0.6 }));
  assert.equal(r.move.san, 'O-O');
});

test('queenside castling', () => {
  const g = new Chess('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
  const r = inferMove(g, scoresFor({ e8: 0.6, c8: 0.6, a8: 0.6, d8: 0.6 }));
  assert.equal(r.move.san, 'O-O-O');
});

test('en passant includes the captured pawn square', () => {
  const g = new Chess('4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1');
  const mv = g.moves({ verbose: true }).find((m) => m.flags.includes('e'));
  assert.deepEqual(touchedSquares(mv).sort(), ['d5', 'e5', 'e6']);
  const r = inferMove(g, scoresFor({ d5: 0.6, e6: 0.6, e5: 0.6 }));
  assert.equal(r.move.san, 'dxe6');
});

test('capture looks the same as a quiet move: from and to change', () => {
  const g = new Chess('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
  const r = inferMove(g, scoresFor({ e4: 0.7, d5: 0.5 }));
  assert.equal(r.move.san, 'exd5');
});

test('promotion uses the chosen piece', () => {
  const g = new Chess('8/4P3/8/8/8/8/k7/4K3 w - - 0 1');
  assert.equal(inferMove(g, scoresFor({ e7: 0.7, e8: 0.7 })).move.san, 'e8=Q');
  assert.equal(inferMove(g, scoresFor({ e7: 0.7, e8: 0.7 }), { promotion: 'n' }).move.san, 'e8=N');
});

test('a change no legal move explains is reported', () => {
  const r = inferMove(new Chess(), scoresFor({ e2: 0.8, e5: 0.8 }));
  assert.equal(r.status, 'nofit');
  assert.deepEqual(r.changed.sort(), ['e2', 'e5']);
});

test('two equally likely moves are reported as ambiguous', () => {
  // Only the from-square changed clearly; both pushes fit about the same.
  const r = inferMove(new Chess(), scoresFor({ e2: 0.8, e3: 0.5, e4: 0.5 }));
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.map((m) => m.san).sort(), ['e3', 'e4']);
});

test('PGN gets headers and result', () => {
  const g = new Chess();
  for (const m of ['f3', 'e5', 'g4', 'Qh4#']) g.move(m);
  const pgn = buildPgn(g, { White: 'Ali', Black: 'Mei', Event: 'Club night' });
  assert.match(pgn, /\[White "Ali"\]/);
  assert.match(pgn, /\[Result "0-1"\]/);
  assert.match(pgn, /Qh4# 0-1/);
});

test('a hand or shadow over many squares is reported as covered, not as a move', () => {
  const map = {};
  for (const sq of ['a1', 'a2', 'b2', 'e2', 'b3', 'c3', 'e3', 'c4', 'd4', 'f4']) map[sq] = 0.7;
  const r = inferMove(new Chess(), scoresFor(map));
  assert.equal(r.status, 'covered');
  assert.equal(r.changed.length, 10);
});

test('a subtle move below the normal threshold is still found when it clearly fits', () => {
  const r = inferMove(new Chess(), scoresFor({ g1: 0.2, f3: 0.18 }));
  assert.equal(r.status, 'move');
  assert.equal(r.move.san, 'Nf3');
  assert.equal(r.weak, true);
});

test('faint noise on unrelated squares is not turned into a move', () => {
  assert.equal(inferMove(new Chess(), scoresFor({ d5: 0.2, a6: 0.18 })).status, 'none');
});
