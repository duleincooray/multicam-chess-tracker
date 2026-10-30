// share.js — board pictures (PNG) and game animations (GIF), and sending games to Lichess.
import { GIFEncoder, quantize, applyPalette } from '../vendor/gifenc.js';

const COLORS = { light: '#ead7b5', dark: '#a7774d', frame: '#5b3720', hl: 'rgba(192,138,45,0.55)', ink: '#fbf6ef' };
const PIECES = {};

/** Load the 12 piece drawings once. The SVGs get an explicit size so they draw reliably on a canvas. */
export async function loadPieces(base = 'vendor/pieces/') {
  if (Object.keys(PIECES).length) return PIECES;
  await Promise.all(['w', 'b'].flatMap((c) => ['K', 'Q', 'R', 'B', 'N', 'P'].map(async (t) => {
    let svg = await (await fetch(`${base}${c}${t}.svg`)).text();
    if (!/<svg[^>]*\swidth=/.test(svg)) svg = svg.replace('<svg ', '<svg width="45" height="45" ');
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    await img.decode();
    PIECES[c + t] = img;
  })));
  return PIECES;
}

/**
 * Draw a position. board: chess.js board() rows (rank 8 first).
 * opts: { flipped, marks: [square names], caption: string }
 */
export function drawPosition(ctx, board, size, opts = {}) {
  const pad = Math.round(size * 0.035), cap = opts.caption ? Math.round(size * 0.09) : 0;
  const sq = (size - 2 * pad) / 8;
  ctx.fillStyle = COLORS.frame;
  ctx.fillRect(0, 0, size, size + cap);
  const lit = new Set(opts.marks || []);
  for (let vr = 0; vr < 8; vr++) for (let vf = 0; vf < 8; vf++) {
    const rank = opts.flipped ? vr : 7 - vr, file = opts.flipped ? 7 - vf : vf;
    const x = pad + vf * sq, y = pad + vr * sq;
    ctx.fillStyle = (file + rank) % 2 ? COLORS.light : COLORS.dark;
    ctx.fillRect(x, y, Math.ceil(sq), Math.ceil(sq));
    if (lit.has('abcdefgh'[file] + (rank + 1))) { ctx.fillStyle = COLORS.hl; ctx.fillRect(x, y, Math.ceil(sq), Math.ceil(sq)); }
    const p = board[7 - rank][file];
    if (p) ctx.drawImage(PIECES[p.color + p.type.toUpperCase()], x + sq * 0.05, y + sq * 0.05, sq * 0.9, sq * 0.9);
  }
  if (cap) {
    ctx.fillStyle = COLORS.ink;
    ctx.font = `500 ${Math.round(cap * 0.42)}px Georgia, serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.caption, pad, size + cap / 2 - pad / 3, size - 2 * pad);
  }
  return { width: size, height: size + cap };
}

export async function pngBlob(board, opts) {
  await loadPieces();
  const cv = document.createElement('canvas');
  const size = 800;
  cv.width = size; cv.height = size + (opts.caption ? Math.round(size * 0.09) : 0);
  drawPosition(cv.getContext('2d'), board, size, opts);
  return new Promise((r) => cv.toBlob(r, 'image/png'));
}

/**
 * An animated GIF of the whole game.
 * frames: [{ board, marks, caption }]; onProgress(i, n) is called as frames are encoded.
 */
export async function gifBlob(frames, { size = 420, delay = 800, lastDelay = 2500, flipped = false, onProgress } = {}) {
  await loadPieces();
  const cv = document.createElement('canvas');
  const cap = Math.round(size * 0.09);
  cv.width = size; cv.height = size + cap;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    drawPosition(ctx, f.board, size, { flipped, marks: f.marks, caption: f.caption || ' ' });
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    const palette = quantize(data, 128);
    gif.writeFrame(applyPalette(data, palette), cv.width, cv.height, { palette, delay: i === frames.length - 1 ? lastDelay : delay });
    onProgress?.(i + 1, frames.length);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r)); // keep the page responsive
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

/**
 * Import a game into Lichess and open it for analysis. The tab is opened straight away (so it isn't
 * blocked as a pop-up) and pointed at the game once Lichess replies. Returns 'opened' or 'pasted'.
 */
export async function openInLichess(pgn) {
  const tab = window.open('about:blank', '_blank');
  try {
    const res = await fetch('https://lichess.org/api/import', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({ pgn }),
    });
    if (!res.ok) throw new Error(`Lichess said ${res.status}`);
    const { url } = await res.json();
    if (tab) tab.location.href = url; else window.open(url, '_blank');
    return 'opened';
  } catch {
    // Fallback: copy the PGN and open Lichess's paste page.
    try { await navigator.clipboard.writeText(pgn); } catch { /* ignore */ }
    if (tab) tab.location.href = 'https://lichess.org/paste'; else window.open('https://lichess.org/paste', '_blank');
    return 'pasted';
  }
}
