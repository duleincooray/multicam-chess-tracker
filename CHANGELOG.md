# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
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
