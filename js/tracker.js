// tracker.js — turns "which squares changed" into a legal chess move.
// No DOM access, so it can be unit-tested in Node.

const FILES = 'abcdefgh';

/** 'e4' -> 28 (a1 = 0, h1 = 7, a8 = 56). */
export function sqIndex(name) {
  return (Number(name[1]) - 1) * 8 + FILES.indexOf(name[0]);
}

/** 28 -> 'e4'. */
export function sqName(index) {
  return FILES[index % 8] + (Math.floor(index / 8) + 1);
}

/** Every square whose contents change when this chess.js verbose move is played. */
export function touchedSquares(move) {
  const s = new Set([move.from, move.to]);
  const rank = move.from[1];
  if (move.flags.includes('k')) { s.add('h' + rank); s.add('f' + rank); }
  if (move.flags.includes('q')) { s.add('a' + rank); s.add('d' + rank); }
  if (move.flags.includes('e')) s.add(move.to[0] + move.from[1]);
  return [...s];
}

/**
 * Pick the legal move that best explains the per-square change scores.
 *
 * game:   a chess.js Chess instance (current position, before the move)
 * scores: 64 numbers in 0..1, the share of each square that changed (a1 = index 0)
 *
 * Returns one of:
 *   { status: 'none' }                                    nothing changed
 *   { status: 'move', move, squares, score }              confident match
 *   { status: 'ambiguous', candidates: [move, move] }     two moves fit about equally
 *   { status: 'nofit', changed: [square names] }          change seen, no legal move fits
 *   { status: 'covered', changed: [square names] }        too many squares changed: a hand,
 *                                                         arm or shadow is probably on the board
 */
export function inferMove(game, scores, opts = {}) {
  const { onT = 0.25, promotion = 'q', margin = 0.05, maxChanged = 8 } = opts;
  const lowT = opts.lowT ?? onT * 0.5;

  const changedIdx = [];
  for (let i = 0; i < 64; i++) if (scores[i] >= onT) changedIdx.push(i);
  if (!changedIdx.length) {
    // Second, gentler pass for subtle moves (small pieces on far squares, one camera at
    // a low angle). Only accepted when one legal move clearly beats every other.
    if (opts.weakPass === false) return { status: 'none' };
    const weak = inferMove(game, scores, {
      ...opts, onT: onT * 0.6, lowT: lowT * 0.6, margin: Math.max(margin, 0.08), weakPass: false,
    });
    return weak.status === 'move' ? { ...weak, weak: true } : { status: 'none' };
  }
  if (changedIdx.length > maxChanged) return { status: 'covered', changed: changedIdx.map(sqName) };

  const ranked = [];
  for (const mv of game.moves({ verbose: true })) {
    if (mv.promotion && mv.promotion !== promotion) continue;
    const squares = touchedSquares(mv);
    const idx = squares.map(sqIndex);
    const vals = idx.map((i) => scores[i]);
    if (Math.min(...vals) < lowT) continue;
    let unexplained = 0;
    for (let i = 0; i < 64; i++) if (!idx.includes(i)) unexplained = Math.max(unexplained, scores[i]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    ranked.push({ score: mean - 0.5 * unexplained, move: mv, squares });
  }

  if (!ranked.length) return { status: 'nofit', changed: changedIdx.map(sqName) };
  ranked.sort((a, b) => b.score - a.score);
  if (ranked.length > 1 && ranked[0].score - ranked[1].score < margin) {
    return { status: 'ambiguous', candidates: [ranked[0].move, ranked[1].move], changed: changedIdx.map(sqName) };
  }
  return { status: 'move', ...ranked[0] };
}

/** PGN text for a game with the given headers. */
export function buildPgn(game, headers) {
  for (const [k, v] of Object.entries(headers)) if (v) game.setHeader(k, String(v));
  let result = '*';
  if (game.isCheckmate()) result = game.turn() === 'w' ? '0-1' : '1-0';
  else if (game.isDraw() || game.isStalemate()) result = '1/2-1/2';
  if (headers.Result && headers.Result !== '*') result = headers.Result;
  game.setHeader('Result', result);
  return game.pgn();
}

/**
 * Second opinion on the last detected move, used when the board stops matching the record
 * (typically because a hand resting near the board was read as a move).
 *
 * gameBefore:      chess.js game at the position before the last move
 * lastSan:         the move that was recorded
 * scoresSincePrev: change per square between the image taken before that move and now
 *
 * Returns { action: 'replace', move }  a different move explains the board better
 *         { action: 'drop' }           nothing really moved; the recorded move was a phantom
 *         { action: 'keep' }           no better explanation; leave the record alone
 */
export function reconsiderLastMove(gameBefore, lastSan, scoresSincePrev, opts = {}) {
  const r = inferMove(gameBefore, scoresSincePrev, opts);
  if (r.status === 'none') return { action: 'drop' };
  if (r.status === 'move' && r.move.san !== lastSan) return { action: 'replace', move: r.move };
  return { action: 'keep' };
}
