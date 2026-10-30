# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Drawn chess pieces (cburnett set) instead of text symbols, on the board and in exports.
- The camera view zooms to the board after calibration (can be turned off in Setup).
- Score sheet shows each player with captured pieces, material lead and clock; the opening name sits above the moves.
- Download and copy PGN moved into a Save or share menu.
- GitHub Actions updated to current versions.
- New single-screen layout with no page scrolling: cameras, board and score sheet side by side; setup, detection settings and saved games moved into a slide-out panel (gear button or S).
- Pieces slide to their new square when a move is recorded; status, move list and panels animate in. Animations are off when the system asks for reduced motion.
- A gentler second detection pass catches subtle moves, and the board is re-checked every 1.5 s while it is still, so fewer moves are missed.

### Added
- End a game by resignation or agreed draw (flag button); time forfeit when a clock runs out, drawn if the opponent cannot mate. PGN gets Result and Termination.
- Optional live evaluation bar while playing.
- Game library: search by player, event or opening; filter by result; per-player wins, draws and losses; import PGN files.
- Printable FIDE-style scoresheet.
- Optional video recording of each camera into the game's folder, with start times in labels.json.
- Board colour themes, move/capture/check sounds, keyboard shortcuts list (?), F to flip.
- Adjust corners: drag calibration corners into place, with a magnifier, instead of re-clicking all four.
- Opening names (Lichess chess-openings list, CC0).
- Captured pieces and material balance.
- On-screen chess clock driven by the detected moves when a time control is set; flags when time runs out.
- Read each move aloud (optional).
- Stockfish review of saved games: evaluation bar, best-move arrow, ?? / ? / ?! marks and accuracy per player, saved with the game.
- Analyse on Lichess button.
- Board image (PNG) and whole-game animation (GIF) export.
- Install as an app, with offline support.
- Dataset: with a games folder connected, a photo from each camera is saved at every move into games/<date-time>/cam-X/ply-NNN.jpg, labelled with the exact position in labels.json and labels.csv (with camera calibration). Photos of undone or corrected moves are removed.
- Detection log: every move records its source (auto, weak, corrected, choice, manual), confidence and time; undos and self-corrections are logged. Setup, Games shows the share of moves recorded without help across games; per-game log.json and an accuracy.csv export.
- Move times in the PGN as [%emt], plus [%clk] clock times when a time control such as 10+5 is set.
- Open saved games to review them: step through the moves with the buttons or arrow keys, or click any move. Esc goes back to the live game.
- Self-correction: if the board stops matching the record after a detected move (for example a resting hand was read as a move), the app compares the board with how it looked before that move and swaps in the move that really happened, or drops the move if nothing moved.
- Every game is saved automatically: the game in progress always appears in Saved games (marked in progress) and is updated after each move. When a game ends it is downloaded as PGN if no games folder is set. The Save & new button is now New game.
- Checkmate celebration: the mated king topples, the winning king rises, confetti bursts from the board and a short fanfare plays (when sound is on). A result card offers Save & new game. Draws and stalemate get a quieter card. Tracking stops when the game ends.
- Games folder: pick a folder once and the game is auto-saved there as a .pgn file after every move (Chrome/Edge). Renaming updates the file. Without a folder, Save & new game downloads the PGN.
- Rename saved games (game name, White, Black); the PGN headers and download file name follow.
- 1920 × 1080 and 2560 × 1440 camera resolutions; the detector now analyses up to 960 px wide for more detail on far squares.
- The camera card shows the resolution the camera actually delivers.
- Compensation for webcam auto-exposure and white-balance drift, so a brightness change no longer looks like moved pieces.
- "Board covered" status when a hand, arm or shadow changes many squares at once, instead of an error.

### Fixed
- A new game no longer inherits the previous game's name.
- Game times are now when the first and last moves were played (shown as a range), not when the page or New game was opened.
- Starting cameras no longer replaces the cameras you picked with the previous choice (it kept opening the built-in camera).
- Setup panels no longer overlap when camera names are long.

## [0.1.0] - 2026-10-30

### Added
- Browser app that tracks a game from one or two webcams.
- Four-click calibration per camera, remembered per device.
- Change detection that samples the far side of each square to cope with angled cameras.
- Legal-move inference including castling, en passant, captures and promotion; asks when two moves fit.
- Live board, move list, manual move entry, undo and re-baseline.
- Game saving in the browser and PGN download/copy.
- Adjustable detection settings and a change heatmap.
- Unit tests, including an end-to-end test with two synthetic cameras.
- GitHub Actions for tests and GitHub Pages deployment.
