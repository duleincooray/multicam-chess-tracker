// vision.js — geometry and change detection. No DOM access, so it can be unit-tested in Node.
//
// Board coordinates: x = file (0 at the a-file edge, 8 at the h-file edge),
//                    y = rank (0 at the rank-1 edge, 8 at the rank-8 edge).
// Image coordinates are normalised to 0..1 so a calibration survives resolution changes.

/** Outer corners of the playing area in board coordinates, in click order. */
export const CORNER_ORDER = ['a1', 'h1', 'h8', 'a8'];
export const BOARD_CORNERS = [[0, 0], [8, 0], [8, 8], [0, 8]];

/** Solve the homography H (3x3, row-major array of 9) that maps 4 src points to 4 dst points. */
export function solveHomography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8x9 augmented matrix.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) throw new Error('Corners are degenerate (three in a line?)');
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  h.push(1);
  return h;
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('Homography is not invertible');
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ].map((v) => v / det);
  return inv.map((v) => v / inv[8]);
}

/** Square index 0..63 (a1 = 0, h1 = 7, a8 = 56) from file 0..7 and rank 0..7. */
export const squareIndex = (file, rank) => rank * 8 + file;

/**
 * Build a sampler for one camera: which pixels to read for each square.
 *
 * corners: 4 normalised image points [x, y] for a1, h1, h8, a8 (outer corners).
 * For an angled camera, each square is sampled on the side furthest from the
 * camera: a piece's own body covers that part, while a tall piece standing in
 * front only leans into the near part.
 */
export function buildSampler(corners, width, height, opts = {}) {
  const { grid = 8, windowFrac = 0.56, offsetFrac = 0.18 } = opts;
  const Hb2i = solveHomography(BOARD_CORNERS, corners);
  const Hi2b = invertH(Hb2i);

  // Direction towards the camera, in board coordinates: where the bottom-centre
  // of the image lands on the board plane, relative to the board centre.
  const [bx, by] = applyH(Hi2b, 0.5, 1.0);
  let vx = bx - 4, vy = by - 4;
  const n = Math.hypot(vx, vy);
  if (!Number.isFinite(n) || n < 1e-6) { vx = 0; vy = 0; } else { vx /= n; vy /= n; }
  const offX = -vx * offsetFrac, offY = -vy * offsetFrac;

  const per = grid * grid;
  const offsets = new Int32Array(64 * per);
  const half = windowFrac / 2;
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const sq = squareIndex(file, rank);
      const cx = file + 0.5 + offX, cy = rank + 0.5 + offY;
      for (let j = 0; j < grid; j++) {
        for (let i = 0; i < grid; i++) {
          const bxp = cx - half + (windowFrac * (i + 0.5)) / grid;
          const byp = cy - half + (windowFrac * (j + 0.5)) / grid;
          const [u, v] = applyH(Hb2i, bxp, byp);
          const px = Math.min(width - 1, Math.max(0, Math.round(u * width)));
          const py = Math.min(height - 1, Math.max(0, Math.round(v * height)));
          offsets[sq * per + j * grid + i] = (py * width + px) * 4;
        }
      }
    }
  }
  return { offsets, per, width, height, Hb2i, Hi2b, towardCamera: [vx, vy] };
}

/** Read the sampled RGB values from RGBA pixel data (ImageData.data). */
export function sampleFrame(data, sampler) {
  const { offsets } = sampler;
  const out = new Uint8Array(offsets.length * 3);
  for (let k = 0; k < offsets.length; k++) {
    const o = offsets[k];
    out[k * 3] = data[o];
    out[k * 3 + 1] = data[o + 1];
    out[k * 3 + 2] = data[o + 2];
  }
  return out;
}

/**
 * Per-channel gains that map cur's overall colour onto ref's. This undoes webcam
 * auto-exposure and white-balance drift (e.g. when an arm enters the frame), which
 * would otherwise make every square look changed. A real move only touches 2-4 of
 * the 64 squares, so it barely moves the averages.
 */
export function channelGains(ref, cur) {
  const sr = [0, 0, 0], sc = [0, 0, 0];
  for (let i = 0; i < ref.length; i += 3) {
    for (let c = 0; c < 3; c++) { sr[c] += ref[i + c]; sc[c] += cur[i + c]; }
  }
  return sr.map((v, c) => (sc[c] > 0 ? Math.min(2, Math.max(0.5, v / sc[c])) : 1));
}

const NO_GAIN = [1, 1, 1];

function changed(a, b, k, pixT, g) {
  const i = k * 3;
  return Math.max(
    Math.abs(a[i] - b[i] * g[0]),
    Math.abs(a[i + 1] - b[i + 1] * g[1]),
    Math.abs(a[i + 2] - b[i + 2] * g[2]),
  ) > pixT;
}

/** Fraction of sample points that changed, per square (Float32Array of 64). */
export function squareScores(ref, cur, per, pixT = 30, compensate = true) {
  const g = compensate ? channelGains(ref, cur) : NO_GAIN;
  const scores = new Float32Array(64);
  for (let sq = 0; sq < 64; sq++) {
    let c = 0;
    for (let s = 0; s < per; s++) if (changed(ref, cur, sq * per + s, pixT, g)) c++;
    scores[sq] = c / per;
  }
  return scores;
}

/** Fraction of all sample points that changed between two frames. */
export function motionFraction(prev, cur, pixT = 30, compensate = true) {
  if (!prev) return 1;
  const g = compensate ? channelGains(prev, cur) : NO_GAIN;
  const n = cur.length / 3;
  let c = 0;
  for (let k = 0; k < n; k++) if (changed(prev, cur, k, pixT, g)) c++;
  return c / n;
}

/** Average several cameras' per-square scores. */
export function combineScores(list) {
  const out = new Float32Array(64);
  if (!list.length) return out;
  for (const s of list) for (let i = 0; i < 64; i++) out[i] += s[i];
  for (let i = 0; i < 64; i++) out[i] /= list.length;
  return out;
}
