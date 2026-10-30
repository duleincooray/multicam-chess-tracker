import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import {
  BOARD_CORNERS, solveHomography, applyH, invertH, buildSampler, sampleFrame, squareScores,
  motionFraction, combineScores,
} from '../js/vision.js';
import { inferMove, sqIndex } from '../js/tracker.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('homography maps the four corners exactly and inverts', () => {
  const img = [[0.2, 0.9], [0.85, 0.88], [0.7, 0.3], [0.3, 0.32]];
  const H = solveHomography(BOARD_CORNERS, img);
  BOARD_CORNERS.forEach(([x, y], i) => {
    const [u, v] = applyH(H, x, y);
    close(u, img[i][0]); close(v, img[i][1]);
  });
  const [x, y] = applyH(invertH(H), ...applyH(H, 3.3, 5.1));
  close(x, 3.3); close(y, 5.1);
});

test('degenerate corners are rejected', () => {
  assert.throws(() => solveHomography(BOARD_CORNERS, [[0, 0], [0.5, 0.5], [1, 1], [0.2, 0.2]]));
});

test('sampler knows which way the camera is', () => {
  // White-side camera: rank 1 at the bottom of the image.
  const white = buildSampler([[0.2, 0.9], [0.8, 0.9], [0.65, 0.3], [0.35, 0.3]], 640, 360);
  assert.ok(white.towardCamera[1] < -0.9, 'camera should be towards rank 1');
  // Black-side camera: rank 8 at the bottom.
  const black = buildSampler([[0.65, 0.3], [0.35, 0.3], [0.2, 0.9], [0.8, 0.9]], 640, 360);
  assert.ok(black.towardCamera[1] > 0.9, 'camera should be towards rank 8');
});

// ---- end to end on a synthetic camera image -------------------------------

const W = 320, H = 240;

/** Render a top-down-ish synthetic view: checkered board + coloured discs for pieces. */
function render(game, corners) {
  const Hi2b = invertH(solveHomography(BOARD_CORNERS, corners));
  const data = new Uint8ClampedArray(W * H * 4);
  const board = game.board(); // [rank8..rank1][file]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [bx, by] = applyH(Hi2b, (x + 0.5) / W, (y + 0.5) / H);
      let rgb = [40, 40, 40];
      if (bx >= 0 && bx < 8 && by >= 0 && by < 8) {
        const f = Math.floor(bx), r = Math.floor(by);
        rgb = (f + r) % 2 ? [236, 217, 185] : [169, 124, 80];
        const p = board[7 - r][f];
        if (p && Math.hypot(bx - f - 0.5, by - r - 0.5) < 0.38) rgb = p.color === 'w' ? [250, 250, 245] : [20, 20, 25];
      }
      data.set([...rgb, 255], (y * W + x) * 4);
    }
  }
  return data;
}

test('two synthetic cameras detect a short game', () => {
  const camA = [[0.15, 0.95], [0.85, 0.95], [0.7, 0.25], [0.3, 0.25]]; // white side
  const camB = [[0.7, 0.25], [0.3, 0.25], [0.15, 0.95], [0.85, 0.95]]; // black side
  const samplers = [camA, camB].map((c) => buildSampler(c, W, H));
  const views = [camA, camB];

  const truth = new Chess();
  const tracked = new Chess();
  const snap = () => views.map((c, i) => sampleFrame(render(truth, c), samplers[i]));

  let ref = snap();
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'O-O']) {
    truth.move(san);
    const cur = snap();
    assert.equal(motionFraction(cur[0], cur[0]), 0);
    const scores = combineScores(cur.map((c, i) => squareScores(ref[i], c, samplers[i].per, 30)));
    const r = inferMove(tracked, scores);
    assert.equal(r.status, 'move', `expected ${san}, got ${r.status}`);
    assert.equal(r.move.san, san);
    tracked.move(r.move.san);
    ref = cur;
  }
  assert.ok(scoresSanity());
});

function scoresSanity() {
  const s = combineScores([new Float32Array(64).fill(1), new Float32Array(64)]);
  return s[sqIndex('e4')] === 0.5;
}

test('overall brightness change (webcam auto-exposure) is not seen as a change', () => {
  const corners = [[0.15, 0.95], [0.85, 0.95], [0.7, 0.25], [0.3, 0.25]];
  const smp = buildSampler(corners, W, H);
  const g = new Chess();
  const ref = sampleFrame(render(g, corners), smp);
  const darker = ref.map((v) => Math.round(v * 0.75));
  const raw = squareScores(ref, darker, smp.per, 30, false);
  const fixed = squareScores(ref, darker, smp.per, 30, true);
  assert.ok(raw.filter((v) => v > 0.25).length > 8, 'without compensation many squares look changed');
  assert.ok(fixed.every((v) => v < 0.25), 'with compensation nothing should look changed');
  assert.ok(motionFraction(ref, darker) < 0.004, 'exposure drift should not count as motion');
});
