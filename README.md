# ♞ Chess Cam Tracker

Record over-the-board chess games on an ordinary board using one or two webcams.
It runs entirely in your browser: no install, no server, and no video leaves your computer.

**Open the app:** once GitHub Pages is switched on (see [Deploying](#deploying)), the app lives at
`https://<your-username>.github.io/<repo-name>/`.

## What it does

- Uses **one or two webcams** at an angle. No overhead mount needed.
- You **calibrate** each camera once by clicking the four corners of the board.
- When the board has been still for a moment, it works out **which squares changed** and
  picks the **legal move** that best explains the change. Castling, en passant, captures and
  promotion are handled.
- Shows the moves on a **live board** and a move list.
- **Saves games** in the browser and downloads them as **PGN**, ready for Lichess, Chess.com
  or any chess program.
- If it's unsure, it asks you to pick between the likely moves, and you can always **type a
  missed move** or **undo**.

## Also included

- **Drawn pieces, opening names and material**: the board shows the opening being played (from the Lichess openings list),
  the pieces each side has captured and who is ahead.
- **Chess clock**: set a time control such as `10+5` in Setup and both clocks run on screen, switching sides when a
  move is detected. The same times go into the PGN.
- **Read moves aloud** (Setup, Detection), so you know a move was recorded without looking.
- **Zoomed camera view and corner adjustment**: after calibration the camera view zooms to the board. Press
  **Adjust corners** to drag the corner dots, with a magnifier for precise placement.
- **Review with Stockfish**: open a saved game and Stockfish (running in your browser) checks every move. You get an
  evaluation bar, the engine's best move as an arrow, blunders (??), mistakes (?) and inaccuracies (?!) in the move list,
  and an accuracy score for each player. The analysis is saved with the game.
- **Analyse on Lichess**: one button imports the game into Lichess for its own analysis.
- **Share**: download the PGN, copy it, save a picture of the board, or make an animated GIF of the whole game.
- **Ending a game**: the flag button records a resignation or an agreed draw. When a clock runs out the game ends on
  time, or as a draw if the other side can no longer checkmate (FIDE rule). The PGN gets the right result and termination.
- **Live evaluation bar** (optional, Setup, Detection): Stockfish's assessment of the position while you play.
- **Game library**: search saved games by player, event or opening, filter by result, see each player's wins, draws and
  losses, and import games from any PGN file to review them with Stockfish.
- **Printable scoresheet**: a FIDE-style A4 scoresheet for any game (Save or share, Print scoresheet).
- **Video recording** (optional, needs a games folder): each camera's video is saved next to the photos, with its start
  time in `labels.json` so moves can be matched to the video.
- **Board colours** (walnut, tournament green, ocean, slate), move and capture sounds, and a shortcuts list (press `?`).
- **Install as an app**: Chrome and Edge show an **Install app** button; the installed app has its own window and
  opens without internet.

## Quick start

1. Open the app in **Chrome or Edge** (Firefox works too). Camera access needs `https://` or `localhost`.
2. **Setup → Cameras:** choose Camera A and Camera B (or *None* for one camera) and press **Start cameras**.
3. Press **Calibrate** on each camera and click the outer corners of the playing area in this order:
   **a1 → h1 → h8 → a8**. The green grid should sit exactly on the squares.
4. Set up the pieces, press **Start tracking**, keep hands off the board for a second, then play.
5. When the game is over, press **Save & new game**. Download PGNs from **Saved games**.

### Placing two cameras

Put one camera behind each player, as high as you can and pointing down at the board.
The steeper the angle, the fewer squares get hidden behind tall pieces. Each camera covers the
squares the other one can't see well.

If two cameras won't start at once, they're probably sharing USB bandwidth: pick **640 × 480**
in Setup or plug them into different USB ports.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> | Pause / resume tracking |
| <kbd>U</kbd> | Undo the last move (take it back on the board first) |
| <kbd>B</kbd> | Re-baseline: accept the board as it looks now |
| <kbd>M</kbd> | Type a move |

### Tuning

| Setting | Raise it if… | Lower it if… |
| --- | --- | --- |
| Settle time | moves are read while your hand is still moving | it feels slow |
| Square sensitivity | it sees changes that didn't happen | it misses moves |
| Colour threshold | lighting flicker causes false changes | dark pieces on dark squares are missed |
| Hand / motion threshold | it never says "still" | it reads the board while hands are in view |

Turn on **Show change heatmap** to see what each camera thinks changed.

## Running it locally

Any static file server works; ES modules don't load from `file://`.

```bash
npm install        # only needed for the tests
npm start          # serves http://localhost:8080
# or: python -m http.server 8080
```

## How it works

```
webcam frame ──► sample each square ──► compare with last position ──► change score per square
     (calibrated homography, far side of each square)          │
                                                               ▼
          two cameras averaged ──► every legal move scored by how well it explains the change
                                                               │
                                                               ▼
                                   best move played, board + PGN updated
```

- `js/vision.js` — homography from the four clicked corners, per-square sampling, change and motion scores.
  For an angled camera it samples the side of each square furthest from the camera, because a piece's own body
  covers that part while a tall neighbour in front only leans into the near part.
- `js/tracker.js` — scores every legal move (via [chess.js](https://github.com/jhlywa/chess.js)) against the change
  scores; reports "ambiguous" or "no fit" rather than guessing.
- `js/app.js` — cameras, calibration UI, detection loop, game record, saving.
- `js/research.js` — move times, accuracy summary and dataset labels.
- `js/folder.js` — writes games, photos and labels into the folder you choose.
- `js/storage.js` — safe `localStorage` wrapper (settings, calibrations, games).
- `js/boardinfo.js`, `js/openings.js` — material count, spoken moves, opening names.
- `js/engine.js`, `js/analysis.js` — Stockfish in a background worker, and the review scoring (Lichess's published formulas).
- `js/share.js` — board images, GIFs and the Lichess import.
- `js/library.js` — PGN import, search and player statistics.
- `sw.js`, `manifest.webmanifest`, `icons/` — install as an app and work offline.
- `vendor/` — bundled chess.js, piece set, Stockfish, openings list and GIF encoder, so nothing loads from other sites.
  See [THIRD_PARTY.md](THIRD_PARTY.md) for their licences. Update chess.js with `npm run vendor`.

## Research data

Connect a games folder (Setup, Games) and the app records three things for every game.

### 1. Labelled photos (dataset)

With **Save a photo from each camera at every move** on, each game gets its own folder:

```
games/
  2026-10-30_121536/            one folder per game (date and time the photos started)
    cam-A/ply-000.jpg           starting position, as camera A saw it
    cam-A/ply-001.jpg           after White's first move
    cam-B/ply-001.jpg           ...and from camera B
    labels.json                 what every photo shows, plus camera calibration
    labels.csv                  the same, one row per photo: image, camera, ply, move, fen
    log.json                    every detection, correction and undo
    game.pgn                    the game with move times
  2026-10-30_121536_Dulein_vs_DK.pgn
  accuracy.csv                  one row per game
```

The label of each photo is the exact board position (FEN) after `ply` half-moves, so every square in every
image is labelled. `labels.json` also stores each camera's resolution and the four calibrated board corners
(a1, h1, h8, a8, in normalised image coordinates), which is enough to cut out the 64 squares. When a move is
undone or corrected, its photos are deleted so no image carries a wrong label.

### 2. Detection log and accuracy

Every recorded move is tagged with where it came from:

| Source | Meaning |
| --- | --- |
| `auto` | detected by the cameras |
| `weak` | detected by the gentler second pass |
| `corrected` | the app replaced one of its own misreads |
| `choice` | the app offered two moves and a person picked one |
| `manual` | typed in by a person |

- **Recorded without help** = moves from `auto`, `weak` and `corrected`, divided by all moves in the final record.
- **Misreads** = detected moves that were later undone by hand, plus the ones the app fixed itself.

Setup, Games shows the totals across games, and **Export accuracy CSV** downloads one row per game.

### 3. Move times

Each move in the PGN carries `[%emt h:mm:ss]`, the time it took (from when the board settled after the
previous move to when it settled after this one). If you enter a time control such as `10+5` in Setup, moves also
get `[%clk h:mm:ss]`, the clock left after the move, which Lichess and Chess.com show as clock times.

## Tests

```bash
npm test
```

Tests cover move inference (castling, en passant, promotion, ambiguity), the geometry, and an end-to-end run
where two synthetic cameras watch a short game.

## Deploying

The included workflow publishes the site to GitHub Pages on every push to `main`.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Limitations

- It tracks changes, it doesn't recognise pieces, so the board must start in the normal starting position
  (or the position you continue from) and every move has to be legal.
- Promotions use the piece chosen in *Promote to* (queen by default).
- Big lighting changes, like a cloud passing, can look like moves. Re-baseline with <kbd>B</kbd> if that happens.
- Saved games live in this browser's storage. Download PGNs you want to keep.

## Roadmap

See [issues](../../issues). Ideas: automatic board-corner detection, piece recognition to start from any position,
clock and timestamps, Lichess export, video recording alongside the PGN.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports with a screenshot of the camera view and the heatmap are the
most useful.

## Licence

MIT for this project's code. Bundled components keep their own licences, listed in [THIRD_PARTY.md](THIRD_PARTY.md) (Stockfish and the piece set are GPL).
