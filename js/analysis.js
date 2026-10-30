// analysis.js — turns engine evaluations into a game review. No DOM access.
// Thresholds and formulas follow the ones Lichess publishes for its own game analysis.

/** White's winning chances in [-1, 1] for an evaluation { cp } or { mate } (both from White's side). */
export function winningChances(ev) {
  if (!ev) return 0;
  if (ev.over != null) return ev.over; // game already over: 1 White won, -1 Black won, 0 draw
  if (ev.mate != null) return ev.mate > 0 ? 1 : ev.mate < 0 ? -1 : 0;
  const cp = Math.max(-1000, Math.min(1000, ev.cp));
  return 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
}

/** 0..100 win percentage for White. */
export const winPercent = (ev) => 50 + 50 * winningChances(ev);

/** "+1.3", "-0.4", "M3", "-M2". */
export function formatEval(ev) {
  if (!ev) return '';
  if (ev.text) return ev.text;
  if (ev.mate != null) return `${ev.mate < 0 ? '-' : ''}M${Math.abs(ev.mate)}`;
  const v = ev.cp / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

/**
 * Judge each move. evals[i] is the evaluation of the position after i half-moves (evals[0] = start).
 * Returns one entry per move: { mark: '??' | '?' | '?!' | '', label, accuracy }.
 */
export function judgeMoves(evals) {
  const out = [];
  for (let i = 1; i < evals.length; i++) {
    const mover = i % 2 === 1 ? 1 : -1; // White made odd-numbered half-moves
    const before = winningChances(evals[i - 1]) * mover;
    const after = winningChances(evals[i]) * mover;
    const loss = Math.max(0, before - after); // in [-1, 1] units
    let mark = '', label = '';
    if (loss >= 0.3) { mark = '??'; label = 'blunder'; }
    else if (loss >= 0.2) { mark = '?'; label = 'mistake'; }
    else if (loss >= 0.1) { mark = '?!'; label = 'inaccuracy'; }
    const drop = loss * 50; // in win-percentage points
    const accuracy = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
    out.push({ mark, label, accuracy });
  }
  return out;
}

/** Per-side totals: average accuracy and counts of inaccuracies, mistakes and blunders. */
export function reviewSummary(judged) {
  const side = (s) => {
    const mine = judged.filter((_, i) => (i % 2 === 0) === (s === 'w'));
    const count = (l) => mine.filter((m) => m.label === l).length;
    return {
      accuracy: mine.length ? Math.round(mine.reduce((a, m) => a + m.accuracy, 0) / mine.length) : null,
      inaccuracies: count('inaccuracy'), mistakes: count('mistake'), blunders: count('blunder'),
    };
  };
  return { w: side('w'), b: side('b') };
}

/** Parse a UCI "info" line into { depth, cp | mate, pv }, from the side to move's point of view. */
export function parseInfo(line) {
  const m = /\bdepth (\d+).*?\bscore (cp|mate) (-?\d+)(?:.*?\bpv ((?:[a-h][1-8][a-h][1-8][qrbn]? ?)+))?/.exec(line);
  if (!m) return null;
  const r = { depth: +m[1], pv: m[4] ? m[4].trim().split(' ') : [] };
  r[m[2]] = +m[3];
  return r;
}
