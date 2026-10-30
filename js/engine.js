// engine.js — Stockfish (lite, single-threaded WebAssembly build) in a background worker.
import { parseInfo } from './analysis.js';

const PATH = 'vendor/stockfish/stockfish-19-lite-single.js';

export class Engine {
  constructor() {
    this.worker = new Worker(PATH);
    this.listeners = new Set();
    this.worker.onmessage = (e) => { for (const f of [...this.listeners]) f(String(e.data)); };
    this.ready = this.command('uci', (l) => l === 'uciok').then(() => this.command('isready', (l) => l === 'readyok'));
  }

  /** Send a command and resolve with the first line that satisfies `done`. */
  command(cmd, done) {
    return new Promise((resolve) => {
      const f = (line) => { if (done(line)) { this.listeners.delete(f); resolve(line); } };
      this.listeners.add(f);
      this.worker.postMessage(cmd);
    });
  }

  /**
   * Evaluate a position. Returns { cp | mate, best, pv } from White's point of view.
   * Stops at `depth` or after `movetime` ms, whichever comes first.
   */
  analyse(fen, opts) {
    // one search at a time: queue requests from the live bar and the game review
    const run = () => this.search(fen, opts);
    this.queue = (this.queue || Promise.resolve()).then(run, run);
    return this.queue;
  }

  async search(fen, { depth = 14, movetime = 800 } = {}) {
    await this.ready;
    let last = null;
    const onInfo = (line) => { if (line.startsWith('info') && / pv /.test(line)) last = parseInfo(line) || last; };
    this.listeners.add(onInfo);
    this.worker.postMessage(`position fen ${fen}`);
    const done = await this.command(`go depth ${depth} movetime ${movetime}`, (l) => l.startsWith('bestmove'));
    this.listeners.delete(onInfo);
    const best = done.split(' ')[1];
    const white = fen.split(' ')[1] === 'w' ? 1 : -1;
    const ev = { best: best && best !== '(none)' ? best : null, pv: last?.pv || [] };
    if (last?.mate != null) ev.mate = last.mate * white;
    else ev.cp = (last?.cp ?? 0) * white;
    return ev;
  }

  stop() { this.worker.postMessage('stop'); }
  terminate() { this.worker.terminate(); }
}
