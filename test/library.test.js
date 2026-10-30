import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { splitPgn, importPgn, playerStats, filterGames } from '../js/library.js';
import { canMate } from '../js/boardinfo.js';

const FILE = `[Event "Club"]
[Date "2026.10.01"]
[White "Ali"]
[Black "Mei"]
[Result "1-0"]

1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0

[Event "Club"]
[White "Mei"]
[Black "Ali"]
[Result "1/2-1/2"]

1. d4 d5 2. c4 e6 {a comment} 1/2-1/2

[Event "Broken"]

1. e4 e5 2. Ke3 Ke6 3. Qz9 *
`;

test('several games in one PGN file', () => {
  assert.equal(splitPgn(FILE).length, 3);
  const { games, failed } = importPgn(FILE, 1000);
  assert.equal(games.length, 2);
  assert.deepEqual(failed, [3]);
  assert.equal(games[0].white, 'Ali');
  assert.equal(games[0].result, '1-0');
  assert.equal(games[0].moves, 7);
  assert.match(games[0].date, /^2026-10-01/);
  assert.equal(new Chess().loadPgn(games[1].pgn) ?? true, true);
});

test('player stats', () => {
  const { games } = importPgn(FILE);
  const s = playerStats([...games, { white: 'Ali', black: 'Mei', result: '*' }]);
  const ali = s.find((p) => p.name === 'Ali');
  assert.deepEqual([ali.games, ali.wins, ali.draws, ali.losses], [2, 1, 1, 0]);
  assert.equal(ali.score, 0.75);
});

test('search and result filter', () => {
  const g = [
    { white: 'Ali', black: 'Mei', event: 'Club', result: '1-0', opening: 'Italian Game' },
    { white: 'Sam', black: 'Ali', event: 'Online', result: '*', inProgress: true },
  ];
  assert.equal(filterGames(g, 'ali').length, 2);
  assert.equal(filterGames(g, 'italian').length, 1);
  assert.equal(filterGames(g, '', 'unfinished').length, 1);
  assert.equal(filterGames(g, '', '1-0').length, 1);
});

test('who can still mate when the other clock runs out', () => {
  const b = (fen) => new Chess(fen).board();
  assert.equal(canMate(b('4k3/8/8/8/8/8/8/4K3 w - - 0 1'), 'w'), false);      // bare king
  assert.equal(canMate(b('4k3/8/8/8/8/8/8/2B1K3 w - - 0 1'), 'w'), false);    // king + bishop
  assert.equal(canMate(b('4k3/8/8/8/8/8/8/1NB1K3 w - - 0 1'), 'w'), true);    // two minors
  assert.equal(canMate(b('4k3/8/8/8/8/8/P7/4K3 w - - 0 1'), 'w'), true);      // a pawn
});
