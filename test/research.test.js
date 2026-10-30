import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import {
  formatClock, parseTimeControl, timedGame, summarize, totals, accuracyCsv, labelsCsv,
} from '../js/research.js';

test('clock formatting', () => {
  assert.equal(formatClock(0), '0:00:00');
  assert.equal(formatClock(75_000), '0:01:15');
  assert.equal(formatClock(3_725_400), '1:02:05');
});

test('time control parsing', () => {
  assert.deepEqual(parseTimeControl('10+5'), { base: 600, inc: 5 });
  assert.deepEqual(parseTimeControl(' 3 '), { base: 180, inc: 0 });
  assert.equal(parseTimeControl(''), null);
  assert.equal(parseTimeControl('blitz'), null);
});

test('PGN gets move times, and clock times when a time control is set', () => {
  const g = new Chess();
  for (const m of ['e4', 'e5', 'Nf3']) g.move(m);
  const plain = timedGame(g, [5000, 12000, 3000]).pgn();
  assert.match(plain, /1\. e4 \{\[%emt 0:00:05\]\} e5 \{\[%emt 0:00:12\]\} 2\. Nf3 \{\[%emt 0:00:03\]\}/);
  assert.doesNotMatch(plain, /%clk/);

  const timed = timedGame(g, [5000, 12000, 3000], parseTimeControl('10+2')).pgn();
  assert.match(timed, /\[TimeControl "600\+2"\]/);
  assert.match(timed, /e4 \{\[%clk 0:09:57\] \[%emt 0:00:05\]\}/); // 600 - 5 + 2
  assert.match(timed, /Nf3 \{\[%clk 0:09:56\] \[%emt 0:00:03\]\}/); // 597 - 3 + 2
  // the timed PGN still loads
  assert.equal(new Chess().loadPgn(timed) ?? true, true);
});

test('accuracy summary counts help, misreads and fixes', () => {
  const meta = [
    { source: 'auto' }, { source: 'auto' }, { source: 'weak' }, { source: 'corrected' },
    { source: 'manual' }, { source: 'choice' }, { source: 'auto' }, { source: 'auto' },
  ];
  const events = [
    { type: 'move', source: 'auto' }, { type: 'undo', source: 'auto', san: 'Rh7' },
    { type: 'replaced', san: 'Bc4' }, { type: 'dropped', san: 'Qd2' }, { type: 'undo', source: 'manual', san: 'a3' },
  ];
  const s = summarize(meta, events);
  assert.equal(s.moves, 8);
  assert.equal(s.unaided, 6);
  assert.equal(s.unaidedRate, 0.75);
  assert.equal(s.undone, 1);      // the undone manual move doesn't count as a misread
  assert.equal(s.selfFixed, 2);
  assert.equal(s.misreads, 3);

  const t = totals([s, summarize([{ source: 'auto' }, { source: 'auto' }], [])]);
  assert.equal(t.games, 2);
  assert.equal(t.moves, 10);
  assert.equal(t.unaidedRate, 0.8);
});

test('CSV exports', () => {
  const csv = accuracyCsv([{ event: 'Club, night', date: '2026-10-30', white: 'A', black: 'B', result: '1-0',
    summary: summarize([{ source: 'auto' }], []), cameras: 2 }]);
  assert.match(csv, /^game,date,white,black,result,moves,unaided,unaided_rate/);
  assert.match(csv, /"Club, night",2026-10-30,A,B,1-0,1,1,1.000/);

  const labels = labelsCsv([{ ply: 1, san: 'e4', fen: 'x', source: 'auto', at: 't', images: { A: 'cam-A/ply-001.jpg', B: 'cam-B/ply-001.jpg' } }]);
  assert.equal(labels.trim().split('\n').length, 3);
  assert.match(labels, /cam-B\/ply-001\.jpg,B,1,e4,x,auto,t/);
});
