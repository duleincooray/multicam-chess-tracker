import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winningChances, winPercent, formatEval, judgeMoves, reviewSummary, parseInfo } from '../js/analysis.js';

test('winning chances', () => {
  assert.equal(winningChances({ cp: 0 }), 0);
  assert.ok(winningChances({ cp: 300 }) > 0.4 && winningChances({ cp: 300 }) < 0.6);
  assert.equal(winningChances({ mate: 3 }), 1);
  assert.equal(winningChances({ mate: -2 }), -1);
  assert.equal(winPercent({ cp: 0 }), 50);
});

test('eval text', () => {
  assert.equal(formatEval({ cp: 130 }), '+1.3');
  assert.equal(formatEval({ cp: -45 }), '-0.5');
  assert.equal(formatEval({ mate: -2 }), '-M2');
});

test('blunders, mistakes and inaccuracies', () => {
  // start, 1.e4 (fine), 1...?? hangs a queen, 2.good, 2...? mistake
  const evals = [{ cp: 20 }, { cp: 30 }, { cp: 900 }, { cp: 880 }, { cp: 2000 }];
  const j = judgeMoves(evals);
  assert.deepEqual(j.map((m) => m.mark), ['', '??', '', '']);
  const k = judgeMoves([{ cp: 0 }, { cp: 0 }, { cp: 150 }, { cp: 150 }, { cp: 260 }]);
  assert.deepEqual(k.map((m) => m.label), ['', 'mistake', '', 'inaccuracy']); // -1.5 is a mistake, -1.1 more an inaccuracy
  const s = reviewSummary(j);
  assert.equal(s.b.blunders, 1);
  assert.equal(s.w.blunders, 0);
  assert.ok(s.w.accuracy > 90 && s.b.accuracy < 70);
});

test('UCI info parsing', () => {
  const i = parseInfo('info depth 14 seldepth 20 multipv 1 score cp -35 nodes 123 nps 1 pv e7e5 g1f3 b8c6');
  assert.deepEqual(i, { depth: 14, cp: -35, pv: ['e7e5', 'g1f3', 'b8c6'] });
  assert.equal(parseInfo('info depth 9 score mate 2 pv d1h5').mate, 2);
  assert.equal(parseInfo('info string NNUE evaluation'), null);
});
