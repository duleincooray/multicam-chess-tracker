// boardinfo.js — material count, captured pieces and spoken move text. No DOM access.

export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };

/**
 * Pieces each side has captured (by type, most valuable first) and the material balance.
 * Promotions are handled by counting a missing pawn only when no extra piece explains it.
 */
export function material(board) {
  const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  let points = { w: 0, b: 0 };
  for (const row of board) for (const sq of row) {
    if (!sq || sq.type === 'k') continue;
    count[sq.color][sq.type]++;
    points[sq.color] += VALUE[sq.type];
  }
  const missing = (color) => {
    const c = count[color];
    // pieces above the starting count must have come from promoted pawns
    const promoted = ['n', 'b', 'r', 'q'].reduce((s, t) => s + Math.max(0, c[t] - START[t]), 0);
    const out = [];
    for (const t of ['q', 'r', 'b', 'n']) for (let i = c[t]; i < START[t]; i++) out.push(t);
    for (let i = c.p + promoted; i < START.p; i++) out.push('p');
    return out;
  };
  return {
    capturedBy: { w: missing('b'), b: missing('w') }, // white has captured these black pieces
    diff: points.w - points.b,                          // positive: White is ahead
  };
}

const NAMES = { K: 'King', Q: 'Queen', R: 'Rook', B: 'Bishop', N: 'Knight' };

/** "Nxf3+" -> "Knight takes f3, check". */
export function sanToWords(san) {
  let words;
  const tail = san.endsWith('#') ? ', checkmate' : san.endsWith('+') ? ', check' : '';
  const s = san.replace(/[+#?!]/g, '');
  if (s === 'O-O-O') words = 'castles queenside';
  else if (s === 'O-O') words = 'castles kingside';
  else {
    const m = /^([KQRBN])?([a-h]?[1-8]?)(x)?([a-h][1-8])(?:=([QRBN]))?$/.exec(s);
    if (!m) return san;
    const [, piece, from, takes, to, promo] = m;
    words = piece ? NAMES[piece] : takes ? from : '';
    if (piece && from) words += ` ${from}`;
    words += takes ? ` takes ${to}` : `${words ? ' ' : ''}${to}`;
    if (promo) words += `, promotes to ${NAMES[promo]}`;
  }
  return (words + tail).trim();
}

/**
 * Can this side still deliver checkmate in some legal sequence? Used when a clock runs out:
 * under FIDE rules the game is drawn, not lost, if the opponent cannot possibly mate.
 */
export function canMate(board, color) {
  let minors = 0;
  for (const row of board) for (const sq of row) {
    if (!sq || sq.color !== color || sq.type === 'k') continue;
    if (sq.type === 'p' || sq.type === 'r' || sq.type === 'q') return true;
    minors++;
  }
  return minors >= 2;
}
