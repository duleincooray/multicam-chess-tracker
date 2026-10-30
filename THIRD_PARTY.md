# Third-party components

Chess Cam Tracker's own code is MIT licensed (see `LICENSE`). It ships with these components, each under its own licence:

| Component | Where | Author | Licence |
| --- | --- | --- | --- |
| [chess.js](https://github.com/jhlywa/chess.js) | `vendor/chess.js` | Jeff Hlywa | BSD-2-Clause (`vendor/chess.js.LICENSE`) |
| cburnett chess pieces | `vendor/pieces/` | [Colin M.L. Burnett](https://en.wikipedia.org/wiki/User:Cburnett), as distributed by [Lichess](https://github.com/lichess-org/lila) | GPLv2 or later |
| [Stockfish.js](https://github.com/nmrugg/stockfish.js) (Stockfish 19, lite single-threaded) | `vendor/stockfish/` | The Stockfish developers; WebAssembly build by Nathan Rugg | GPLv3 (`vendor/stockfish/COPYING.txt`) |
| [Lichess chess-openings](https://github.com/lichess-org/chess-openings) | `vendor/openings.json` (built by `scripts/build-openings.js`) | Lichess contributors | CC0 (public domain) |
| [gifenc](https://github.com/mattdesl/gifenc) | `vendor/gifenc.js` | Matt DesLauriers | MIT |
| Hanken Grotesk and Newsreader fonts | loaded from Google Fonts | Their designers | SIL Open Font License |

Stockfish runs as a separate program inside a browser worker and talks to the app only through the UCI text protocol.
Its source code is available from the Stockfish and Stockfish.js projects linked above.
