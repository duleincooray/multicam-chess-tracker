// Builds vendor/openings.json from the Lichess chess-openings TSV files (CC0, public domain).
// Usage: download a.tsv … e.tsv from https://github.com/lichess-org/chess-openings into a folder, then
//   node scripts/build-openings.js path/to/folder
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { positionKey } from '../js/openings.js';

const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/build-openings.js <folder with a.tsv … e.tsv>'); process.exit(1); }
const out = {};
let n = 0;
for (const f of ['a', 'b', 'c', 'd', 'e']) {
  const lines = readFileSync(join(dir, `${f}.tsv`), 'utf8').trim().split('\n').slice(1);
  for (const line of lines) {
    const [eco, name, pgn] = line.split('\t');
    const g = new Chess();
    try { g.loadPgn(pgn); } catch { continue; }
    out[positionKey(g.fen())] = [eco, name];
    n++;
  }
}
writeFileSync('vendor/openings.json', JSON.stringify(out));
console.log(`vendor/openings.json: ${Object.keys(out).length} positions from ${n} lines`);
