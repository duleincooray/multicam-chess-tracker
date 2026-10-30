// openings.js — names the opening being played, using the Lichess chess-openings list (CC0).

/** Board, side to move, castling rights and en-passant square: enough to identify an opening position. */
export const positionKey = (fen) => fen.split(' ').slice(0, 4).join(' ');

/**
 * The most specific named opening reached in the game so far.
 * fens: the position after each move, in order. table: { positionKey: [eco, name] }.
 */
export function openingFor(fens, table) {
  for (let i = fens.length - 1; i >= 0; i--) {
    const hit = table[positionKey(fens[i])];
    if (hit) return { eco: hit[0], name: hit[1], ply: i + 1 };
  }
  return null;
}
