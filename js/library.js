// library.js — importing PGN files and summarising saved games. No DOM access.
import { Chess } from 'chess.js';

/** Split a file containing several PGN games into one string per game. */
export function splitPgn(text) {
  const games = [];
  let cur = [], hasMoves = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const isHeader = /^\s*\[/.test(line);
    // a header line after some moves starts the next game
    if (isHeader && hasMoves) { games.push(cur.join('\n').trim()); cur = []; hasMoves = false; }
    if (!isHeader && line.trim()) hasMoves = true;
    cur.push(line);
  }
  if (cur.join('').trim()) games.push(cur.join('\n').trim());
  return games.filter(Boolean);
}

/** Turn PGN text into saved-game records. Games that don't parse are skipped and counted. */
export function importPgn(text, now = Date.now()) {
  const games = [], failed = [];
  splitPgn(text).forEach((pgn, i) => {
    const g = new Chess();
    try { g.loadPgn(pgn); } catch { failed.push(i + 1); return; }
    const h = g.getHeaders();
    const d = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(h.Date || '');
    games.push({
      id: now + i, imported: true,
      date: d ? new Date(`${d[1]}-${d[2]}-${d[3]}T12:00:00`).toISOString() : new Date(now).toISOString(),
      white: h.White || 'White', black: h.Black || 'Black', event: h.Event || 'Imported game',
      result: h.Result || '*', moves: g.history().length, pgn: g.pgn(), inProgress: false,
    });
  });
  return { games, failed };
}

/** Wins, draws and losses for every player name in the saved games. */
export function playerStats(games, ignore = ['White', 'Black']) {
  const by = new Map();
  const add = (name, key) => {
    if (!name || ignore.includes(name)) return; // placeholder names, not real players
    const s = by.get(name) || { name, games: 0, wins: 0, draws: 0, losses: 0 };
    s.games++; s[key]++;
    by.set(name, s);
  };
  for (const g of games) {
    if (!['1-0', '0-1', '1/2-1/2'].includes(g.result)) continue;
    const r = g.result;
    add(g.white, r === '1-0' ? 'wins' : r === '0-1' ? 'losses' : 'draws');
    add(g.black, r === '0-1' ? 'wins' : r === '1-0' ? 'losses' : 'draws');
  }
  return [...by.values()]
    .map((s) => ({ ...s, score: (s.wins + s.draws / 2) / s.games }))
    .sort((a, b) => b.games - a.games || b.score - a.score);
}

/** Filter saved games by free text (players, event, opening) and by result. */
export function filterGames(games, query = '', result = 'all') {
  const q = query.trim().toLowerCase();
  return games.filter((g) => {
    if (result === 'unfinished' ? !(g.inProgress || g.result === '*') : result !== 'all' && g.result !== result) return false;
    if (!q) return true;
    return [g.white, g.black, g.event, g.opening].some((v) => v && v.toLowerCase().includes(q));
  });
}
