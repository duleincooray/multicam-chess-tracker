# Contributing

Thanks for helping! The app is plain HTML, CSS and JavaScript modules with no build step.

## Setup

```bash
npm install
npm start      # http://localhost:8080
npm test
```

## Where things live

- `js/vision.js` and `js/tracker.js` have no DOM code. Put new detection logic here and add tests in `test/`.
- `js/app.js` is the page: cameras, calibration, rendering, saving.

## Workflow

1. Open an issue first for anything bigger than a small fix.
2. Create a branch, keep changes focused, and add or update tests.
3. Make sure `npm test` passes.
4. Add a line under **Unreleased** in `CHANGELOG.md`.
5. Open a pull request describing what changed and how you tested it (with real cameras if it touches detection).

## Releasing

1. Move the **Unreleased** notes in `CHANGELOG.md` under a new version heading.
2. Bump `version` in `package.json`.
3. Commit, tag (`git tag v0.2.0`) and push with `git push --follow-tags`.
4. Create a GitHub release from the tag and paste the changelog notes.
