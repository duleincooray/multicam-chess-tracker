// research.js — move times, the detection log and dataset labels. No DOM access, so it can be tested in Node.
import { Chess } from 'chess.js';

/**
 * Where each recorded move came from:
 *   auto       detected by the cameras
 *   weak       detected by the gentler second pass
 *   corrected  detected after the app replaced one of its own misreads
 *   choice     the app offered two moves and a person picked one
 *   manual     typed in by a person
 *   unknown    recorded by an older version of the app
 */
export const HELPED = new Set(['choice', 'manual']);

/** 75000 -> "0:01:15" (PGN clock format). */
export function formatClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** "10+5" -> { base: 600, inc: 5 } (minutes + seconds per move). Returns null if empty or unreadable. */
export function parseTimeControl(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\+\s*(\d+))?\s*$/.exec(text || '');
  if (!m) return null;
  return { base: Math.round(parseFloat(m[1]) * 60), inc: parseInt(m[2] || '0', 10) };
}

/**
 * A copy of the game with a time comment after every move:
 *   [%emt 0:00:12]  time the move took (always)
 *   [%clk 0:09:48]  clock left after the move (only when a time control is given)
 * Lichess and Chess.com read %clk; ChessBase and others read %emt.
 */
export function timedGame(game, emts, tc) {
  const hist = game.history({ verbose: true });
  const out = hist.length ? new Chess(hist[0].before) : new Chess(game.fen());
  const clock = { w: (tc?.base ?? 0) * 1000, b: (tc?.base ?? 0) * 1000 };
  hist.forEach((m, i) => {
    out.move(m.san);
    const e = emts[i];
    if (e == null || !Number.isFinite(e)) return;
    let note = `[%emt ${formatClock(e)}]`;
    if (tc) {
      clock[m.color] = clock[m.color] - e + tc.inc * 1000;
      note = `[%clk ${formatClock(clock[m.color])}] ${note}`;
    }
    out.setComment(note);
  });
  if (tc) out.setHeader('TimeControl', `${tc.base}+${tc.inc}`);
  return out;
}

/**
 * Accuracy numbers for one game.
 * meta:   one entry per move in the final record: { source, conf }
 * events: everything that happened, including moves later removed:
 *         { type: 'move' | 'undo' | 'replaced' | 'dropped', source?, san }
 */
export function summarize(meta = [], events = []) {
  const count = (src) => meta.filter((m) => m.source === src).length;
  const moves = meta.length;
  const helped = meta.filter((m) => HELPED.has(m.source)).length;
  const undoneDetections = events.filter((e) => e.type === 'undo' && !HELPED.has(e.source)).length;
  const selfFixed = events.filter((e) => e.type === 'replaced' || e.type === 'dropped').length;
  return {
    moves,
    auto: count('auto'),
    weak: count('weak'),
    corrected: count('corrected'),
    choice: count('choice'),
    manual: count('manual'),
    unaided: moves - helped,                 // recorded with no human input
    unaidedRate: moves ? (moves - helped) / moves : null,
    misreads: undoneDetections + selfFixed,  // detections that turned out wrong
    selfFixed,                               // ...that the app fixed by itself
    undone: undoneDetections,                // ...that a person undid
  };
}

/** Add up several games' summaries. */
export function totals(list) {
  const keys = ['moves', 'auto', 'weak', 'corrected', 'choice', 'manual', 'unaided', 'misreads', 'selfFixed', 'undone'];
  const t = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const s of list) for (const k of keys) t[k] += s[k] || 0;
  t.games = list.length;
  t.unaidedRate = t.moves ? t.unaided / t.moves : null;
  return t;
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

/** One row per game, for the accuracy export. */
export function accuracyCsv(games) {
  const head = ['game', 'date', 'white', 'black', 'result', 'moves', 'unaided', 'unaided_rate', 'auto', 'weak',
    'corrected', 'choice', 'manual', 'misreads', 'self_fixed', 'undone', 'cameras'];
  const rows = games.filter((g) => g.summary).map((g) => {
    const s = g.summary;
    return [g.event, g.date, g.white, g.black, g.result, s.moves, s.unaided, s.unaidedRate?.toFixed(3), s.auto, s.weak,
      s.corrected, s.choice, s.manual, s.misreads, s.selfFixed, s.undone, g.cameras ?? ''];
  });
  return toCsv([head, ...rows]);
}

/** One row per saved photo: the label for each image is the board position (FEN) it shows. */
export function labelsCsv(entries) {
  const head = ['image', 'camera', 'ply', 'move', 'fen', 'source', 'time'];
  const rows = [];
  for (const e of entries) {
    for (const [cam, path] of Object.entries(e.images || {})) rows.push([path, cam, e.ply, e.san ?? '', e.fen, e.source ?? '', e.at]);
  }
  return toCsv([head, ...rows]);
}

/**
 * Clock time left for each side, from the recorded move times.
 * meta: per-move { emt }; tc: { base, inc }; now and startAt in ms; turn: 'w' | 'b'.
 * The side to move is charged the time since the last move (or since startAt before the first move).
 */
export function clockState(meta, tc, turn, now, startAt) {
  if (!tc) return null;
  const left = { w: tc.base * 1000, b: tc.base * 1000 };
  meta.forEach((m, i) => {
    const side = i % 2 === 0 ? 'w' : 'b';
    left[side] += -(m.emt || 0) + tc.inc * 1000;
  });
  const since = meta.at(-1)?.at ?? startAt;
  if (since != null) left[turn] -= Math.max(0, now - since);
  return { w: Math.max(0, left.w), b: Math.max(0, left.b), running: since != null ? turn : null };
}
