// app.js — wires cameras, calibration, detection and the game record to the page.
import { Chess } from 'chess.js';
import {
  CORNER_ORDER, buildSampler, sampleFrame, squareScores, motionFraction, combineScores, applyH, squareIndex,
} from './vision.js';
import { inferMove, touchedSquares, buildPgn, sqIndex } from './tracker.js';
import * as store from './storage.js';
import * as folder from './folder.js';

const DEFAULTS = { settle: 1.0, squareT: 0.25, pixelT: 30, motionT: 0.004, sound: true, heatmap: false };
const WORK_W_MAX = 960; // max width of the image the detector analyses (more detail on far squares)
const TICK_MS = 100;    // detector runs ~10 times a second
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

const $ = (id) => document.getElementById(id);
const settings = { ...DEFAULTS, ...store.get('settings', {}) };

const state = {
  cams: [],
  tracking: false,
  game: new Chess(),
  flipped: store.get('flipped', false),
  marks: { squares: [], kind: 'ok' },
  stillSince: null,
  analysed: false,
  moving: false,
  pending: null,
  audio: null,
};

// ───────────────────────────────────────── status

function setStatus(text, kind = 'idle') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

const turnName = () => (state.game.turn() === 'w' ? 'White' : 'Black');

// ───────────────────────────────────────── cameras

async function listCameras(askPermission = false) {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('This browser cannot use webcams. Try Chrome or Edge over https or localhost.', 'warn');
    return [];
  }
  if (askPermission) {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    s.getTracks().forEach((t) => t.stop());
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const needsPermission = devices.length === 0 || devices.some((d) => !d.deviceId || !d.label);
  const saved = store.get('camChoice', {});

  for (const [selId, fallbackIdx] of [['camA', 0], ['camB', 1]]) {
    const sel = $(selId);
    sel.innerHTML = '';
    if (selId === 'camB') sel.add(new Option('None (one camera)', 'none'));
    if (needsPermission) {
      sel.add(new Option(selId === 'camA' ? 'Press "Start cameras" to allow access' : 'Waiting for access…', ''));
      continue;
    }
    devices.forEach((d, i) => sel.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
    const want = saved[selId];
    const fallback = devices[fallbackIdx]?.deviceId ?? 'none';
    sel.value = devices.some((d) => d.deviceId === want) || want === 'none' ? want : fallback;
  }
  return { devices, needsPermission };
}

function stopCameras() {
  for (const c of state.cams) c.stream?.getTracks().forEach((t) => t.stop());
  state.cams = [];
  $('cams').innerHTML = '';
  setTracking(false);
}

function saveCamChoice() {
  if ($('camA').value) store.set('camChoice', { camA: $('camA').value, camB: $('camB').value });
}

async function startCameras() {
  // Keep what the user picked. Only rebuild the lists when we don't have
  // camera access yet (the dropdowns show a placeholder instead of real cameras).
  saveCamChoice();
  if (!$('camA').value) {
    try {
      await listCameras(true);
    } catch (err) {
      setStatus(`Camera access was blocked: ${err.message}. Allow it in the address bar and try again.`, 'warn');
      return;
    }
  }
  saveCamChoice();
  stopCameras();

  const [w, h] = $('resolution').value.split('x').map(Number);
  const picks = [['A', $('camA').value], ['B', $('camB').value]]
    .filter(([, id]) => id && id !== 'none')
    .filter(([, id], i, arr) => arr.findIndex(([, j]) => j === id) === i);

  if (!picks.length) { setStatus('Choose at least one camera.', 'warn'); return; }

  const failed = [];
  for (const [key, deviceId] of picks) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: w }, height: { ideal: h } }, audio: false,
      });
      await addCamera(key, deviceId, stream);
    } catch (err) {
      failed.push(`Camera ${key} (${err.name})`);
    }
  }
  if (failed.length) {
    setStatus(`${failed.join(', ')} would not start. If both cameras share a USB port, try 640 × 480.`, 'warn');
  } else if (state.cams.some((c) => !c.sampler)) {
    setStatus('Cameras on. Calibrate each one: click its four board corners.', 'busy');
  } else {
    setStatus('Cameras on and calibrated. Press Start tracking.', 'ok');
  }
  updateButtons();
}

async function addCamera(key, deviceId, stream) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));

  const el = $('camTemplate').content.firstElementChild.cloneNode(true);
  const canvas = el.querySelector('canvas');
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.min(1, 960 / vw);
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);

  const work = document.createElement('canvas');
  work.width = Math.min(WORK_W_MAX, vw);
  work.height = Math.round((work.width * vh) / vw);
  const wctx = work.getContext('2d', { willReadFrequently: true });

  const label = stream.getVideoTracks()[0]?.label || `Camera ${key}`;
  const cam = {
    key, deviceId, label, stream, video, el, canvas, ctx: canvas.getContext('2d'), work, wctx,
    corners: [], calibrating: false, sampler: null, prev: null, cur: null, ref: null, motion: 1, scores: null,
  };
  el.querySelector('.cam-title').textContent = `Camera ${key}`;
  el.querySelector('.cam-state').textContent = `${label} · ${vw}×${vh}`;

  const savedCorners = store.get('calib', {})[deviceId];
  if (savedCorners?.length === 4) applyCorners(cam, savedCorners);

  canvas.addEventListener('click', (e) => onCanvasClick(cam, e));
  el.querySelector('.btn-calibrate').addEventListener('click', () => startCalibration(cam));
  el.querySelector('.btn-undo-point').addEventListener('click', () => { cam.corners.pop(); updateCamHint(cam); });
  stream.getVideoTracks()[0]?.addEventListener('ended', () => setStatus(`Camera ${key} disconnected.`, 'warn'));

  $('cams').appendChild(el);
  state.cams.push(cam);
  updateCamHint(cam);
}

// ───────────────────────────────────────── calibration

function startCalibration(cam) {
  cam.calibrating = true;
  cam.corners = [];
  cam.sampler = null;
  cam.ref = null;
  setTracking(false);
  updateCamHint(cam);
  updateButtons();
}

function onCanvasClick(cam, e) {
  if (!cam.calibrating || cam.corners.length >= 4) return;
  const r = cam.canvas.getBoundingClientRect();
  cam.corners.push([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]);
  if (cam.corners.length === 4) {
    try {
      applyCorners(cam, cam.corners);
      const all = store.get('calib', {});
      all[cam.deviceId] = cam.corners;
      store.set('calib', all);
      cam.calibrating = false;
      for (const c of state.cams) c.ref = null; // read the board afresh
    } catch (err) {
      cam.corners = [];
      setStatus(`Calibration failed (${err.message}). Click the four corners again.`, 'warn');
    }
  }
  updateCamHint(cam);
  updateButtons();
}

function applyCorners(cam, corners) {
  cam.corners = corners.map((p) => [...p]);
  cam.sampler = buildSampler(cam.corners, cam.work.width, cam.work.height);
}

function updateCamHint(cam) {
  const hint = cam.el.querySelector('.cam-hint');
  const undo = cam.el.querySelector('.btn-undo-point');
  cam.el.classList.toggle('calibrating', cam.calibrating);
  undo.hidden = !cam.calibrating || cam.corners.length === 0;
  cam.el.querySelector('.btn-calibrate').textContent = cam.sampler ? 'Recalibrate' : 'Calibrate';
  if (cam.calibrating) {
    hint.textContent = `Click the outer corner of square ${CORNER_ORDER[cam.corners.length]} ` +
      `(${cam.corners.length + 1} of 4). Use the corners of the playing area, not the wooden frame.`;
  } else if (cam.sampler) {
    hint.textContent = 'Calibrated. The green grid should sit on the squares.';
  } else {
    hint.textContent = 'Not calibrated yet.';
  }
}

// ───────────────────────────────────────── detection loop

function tick() {
  const ready = state.cams.filter((c) => c.sampler && c.video.readyState >= 2);
  if (!ready.length) return;

  for (const c of ready) {
    c.wctx.filter = 'blur(1px)';
    c.wctx.drawImage(c.video, 0, 0, c.work.width, c.work.height);
    const data = c.wctx.getImageData(0, 0, c.work.width, c.work.height).data;
    c.prev = c.cur;
    c.cur = sampleFrame(data, c.sampler);
    c.motion = motionFraction(c.prev, c.cur, settings.pixelT);
    c.scores = c.ref ? squareScores(c.ref, c.cur, c.sampler.per, settings.pixelT) : null;
  }

  if (!state.tracking) return;
  const now = performance.now();
  state.moving = ready.some((c) => c.motion > settings.motionT);
  if (state.moving) {
    state.stillSince = null;
    state.analysed = false;
  } else if (state.stillSince === null) {
    state.stillSince = now;
  }
  const settled = state.stillSince !== null && now - state.stillSince >= settings.settle * 1000;
  if (settled && !state.analysed) {
    state.analysed = true;
    analyse(ready);
  }
}

function analyse(ready) {
  if (ready.some((c) => !c.ref)) {
    ready.forEach((c) => { c.ref = c.cur; });
    setStatus(`Watching the board. ${turnName()} to move.`, 'ok');
    return;
  }
  const scores = combineScores(ready.map((c) => squareScores(c.ref, c.cur, c.sampler.per, settings.pixelT)));
  const r = inferMove(state.game, scores, { onT: settings.squareT, promotion: $('promotion').value });

  if (r.status === 'move') {
    playMove(r.move);
  } else if (r.status === 'ambiguous') {
    state.pending = r.candidates;
    state.marks = { squares: r.changed, kind: 'warn' };
    showChoice(r.candidates);
    setStatus('Not sure which move that was. Pick it below or type it.', 'busy');
  } else if (r.status === 'covered') {
    state.marks = { squares: [], kind: 'ok' };
    setStatus(`Something is covering the board (${r.changed.length} squares changed). ` +
      'Move hands, arms and shadows out of view. If the lighting changed, press B to re-baseline.', 'busy');
  } else if (r.status === 'nofit') {
    state.marks = { squares: r.changed, kind: 'warn' };
    setStatus(`Change on ${r.changed.join(', ')}, but no legal move fits. Fix the board, re-baseline or type the move.`, 'warn');
  }
}

// ───────────────────────────────────────── game

function playMove(mv) {
  let res;
  try {
    res = state.game.move(typeof mv === 'string' ? mv : { from: mv.from, to: mv.to, promotion: mv.promotion });
  } catch {
    setStatus(`"${mv}" isn't a legal move here.`, 'warn');
    return false;
  }
  state.marks = { squares: touchedSquares(res), kind: 'ok' };
  for (const c of state.cams) if (c.cur) c.ref = c.cur;
  state.pending = null;
  hideChoice();
  saveCurrent();
  renderGame();
  beep();

  const num = Math.ceil(state.game.history().length / 2);
  let msg = `${num}${res.color === 'w' ? '.' : '…'} ${res.san} recorded. ${turnName()} to move.`;
  if (state.game.isCheckmate()) msg = `${res.san}: checkmate! ${res.color === 'w' ? 'White' : 'Black'} wins.`;
  else if (state.game.isDraw()) msg = `${res.san}: draw.`;
  setStatus(msg, 'ok');
  return true;
}

function undoMove() {
  const undone = state.game.undo();
  if (!undone) return;
  for (const c of state.cams) if (c.cur) c.ref = c.cur;
  state.marks = { squares: [], kind: 'ok' };
  hideChoice();
  saveCurrent();
  renderGame();
  setStatus(`Undid ${undone.san}. Make sure the board matches, then carry on.`, 'busy');
}

function rebaseline() {
  for (const c of state.cams) if (c.cur) c.ref = c.cur;
  state.marks = { squares: [], kind: 'ok' };
  hideChoice();
  setStatus('Board accepted as it looks now.', 'ok');
}

function headers() {
  return {
    Event: $('event').value || 'Casual game',
    Site: 'Chess Cam Tracker',
    Date: (store.get('current', {}).started || new Date().toISOString()).slice(0, 10).replaceAll('-', '.'),
    White: $('white').value || 'White',
    Black: $('black').value || 'Black',
  };
}

function currentPgn() {
  const g = new Chess();
  g.loadPgn(state.game.pgn());
  return buildPgn(g, headers());
}

let autosaveChain = Promise.resolve();

/** Remember the game in the browser and, if a games folder is set, write it there after every move. */
function saveCurrent() {
  const cur = store.get('current', {});
  const started = cur.started || new Date().toISOString();
  const white = $('white').value, black = $('black').value, event = $('event').value;
  const file = pgnName(white || 'White', black || 'Black', started, event || 'Casual game');
  store.set('current', { started, pgn: state.game.pgn(), white, black, event, file });
  if (state.game.history().length || cur.file) {
    autosaveChain = autosaveChain.then(() => autosave(file, cur.file)).catch((err) => console.warn('Autosave failed', err));
  }
}

async function autosave(file, oldFile) {
  if (!folder.folderName()) return;
  if (!(await folder.ensurePermission(false))) {
    state.needsFolderPermission = true;
    renderFolder();
    return;
  }
  await folder.writeFile(file, currentPgn());
  if (oldFile && oldFile !== file) await folder.removeFile(oldFile);
  state.autosavedFile = file;
  renderFolder();
}

function restoreCurrent() {
  const cur = store.get('current', null);
  if (!cur) return;
  $('white').value = cur.white || '';
  $('black').value = cur.black || '';
  $('event').value = cur.event || '';
  if (cur.pgn) {
    try { state.game.loadPgn(cur.pgn); } catch { state.game.reset(); }
  }
}

async function saveAndNewGame() {
  let note = 'Game saved.';
  if (state.game.history().length) {
    const games = store.get('games', []);
    const h = headers();
    const pgn = currentPgn();
    const date = new Date().toISOString();
    await autosaveChain; // let any in-flight autosave finish first
    const g = {
      id: Date.now(), date, white: h.White, black: h.Black, event: h.Event,
      result: pgn.match(/\[Result "([^"]+)"\]/)?.[1] ?? '*', moves: state.game.history().length, pgn,
      // same name as the autosaved file, so the final save replaces it
      file: store.get('current', {}).file || pgnName(h.White, h.Black, date, h.Event),
    };
    games.unshift(g);
    if (!store.set('games', games)) note = 'Could not keep it in this browser.';
    note += ' ' + await writePgnFile(g.file, pgn);
  }
  state.game = new Chess();
  store.set('current', { started: new Date().toISOString(), pgn: '', white: $('white').value, black: $('black').value, event: $('event').value });
  state.autosavedFile = null;
  for (const c of state.cams) if (c.cur) c.ref = c.cur;
  state.marks = { squares: [], kind: 'ok' };
  hideChoice();
  renderGame();
  renderSaved();
  setStatus(`${note} Set up the pieces for a new game.`, 'ok');
}

/** Save a PGN into the games folder if one is set, otherwise download it. Returns a status note. */
async function writePgnFile(name, pgn) {
  if (folder.folderName()) {
    try {
      if (await folder.writeFile(name, pgn)) return `Written to ${folder.folderName()}/${name}.`;
    } catch (err) {
      console.warn('Folder write failed', err);
    }
    download(pgn, name);
    return 'Could not write to the games folder, so it was downloaded instead.';
  }
  download(pgn, name);
  return `Downloaded ${name}.`;
}

async function chooseFolder() {
  if (state.needsFolderPermission && folder.folderName()) {
    if (await folder.ensurePermission(true)) {
      state.needsFolderPermission = false;
      renderFolder();
      saveCurrent();
      setStatus(`Auto-saving to "${folder.folderName()}" again.`, 'ok');
    }
    return;
  }
  try {
    await folder.choose();
    state.needsFolderPermission = false;
    renderFolder();
    saveCurrent(); // write the game in progress straight away
    setStatus(`Games will be saved to "${folder.folderName()}".`, 'ok');
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(`Could not use that folder: ${err.message}`, 'warn');
  }
}

async function exportAll() {
  const games = store.get('games', []);
  let n = 0;
  for (const g of games) {
    g.file ||= pgnName(g.white, g.black, g.date, g.event);
    try { if (await folder.writeFile(g.file, g.pgn)) n++; } catch { /* reported below */ }
  }
  store.set('games', games);
  setStatus(n === games.length ? `Saved ${n} games to "${folder.folderName()}".`
    : `Saved ${n} of ${games.length} games. Check the folder permission and try again.`, n === games.length ? 'ok' : 'warn');
}

function renderFolder() {
  if (!folder.supported) {
    $('btnFolder').hidden = true;
    $('folderName').textContent = 'not available in this browser';
    $('folderHint').textContent = 'Saving to a folder needs Chrome or Edge. Games download to your Downloads folder instead.';
    return;
  }
  const name = folder.folderName();
  if (name && state.needsFolderPermission) {
    $('folderName').textContent = `${name} (paused: click Allow to keep auto-saving)`;
    $('btnFolder').textContent = 'Allow';
  } else {
    $('folderName').textContent = name ?? 'not set (games go to Downloads)';
    $('btnFolder').textContent = name ? 'Change folder…' : 'Choose folder…';
  }
  $('folderHint').textContent = name
    ? `Auto-saving after every move${state.autosavedFile ? ` to ${state.autosavedFile}` : ''}.`
    : 'Pick a folder and the game is saved there as a .pgn file after every move. Without a folder, games download to your Downloads folder when you press Save & new game.';
  $('btnExportAll').hidden = !name || store.get('games', []).length === 0;
}

function download(text, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-chess-pgn' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function pgnName(white, black, iso, event) {
  const safe = (s) => String(s).replace(/[^\w-]+/g, '_').slice(0, 30);
  const name = event && event !== 'Casual game' ? `${safe(event)}_` : '';
  // Local date and time, so two games on the same day never overwrite each other.
  const d = new Date(iso), pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}_${name}${safe(white)}_vs_${safe(black)}.pgn`;
}

// ───────────────────────────────────────── rendering

function renderBoard() {
  const board = $('board');
  board.innerHTML = '';
  const rows = state.game.board(); // rows[0] is rank 8
  const lit = new Set(state.marks.kind === 'ok' ? state.marks.squares : []);
  for (let vr = 0; vr < 8; vr++) {
    for (let vf = 0; vf < 8; vf++) {
      const rank = state.flipped ? vr : 7 - vr;    // 0 = rank 1
      const file = state.flipped ? 7 - vf : vf;
      const p = rows[7 - rank][file];
      const name = 'abcdefgh'[file] + (rank + 1);
      const sq = document.createElement('div');
      sq.className = `sq ${(file + rank) % 2 ? 'light' : 'dark'}${lit.has(name) ? ' hl' : ''}`;
      if (p) sq.innerHTML = `<span class="pc ${p.color}">${GLYPH[p.type]}</span>`;
      if (vr === 7) sq.insertAdjacentHTML('beforeend', `<span class="coord file">${'abcdefgh'[file]}</span>`);
      if (vf === 0) sq.insertAdjacentHTML('beforeend', `<span class="coord rank">${rank + 1}</span>`);
      board.appendChild(sq);
    }
  }
}

function renderMoves() {
  const list = $('moves');
  const hist = state.game.history();
  list.innerHTML = '';
  for (let i = 0; i < hist.length; i += 2) {
    const li = document.createElement('li');
    for (const j of [i, i + 1]) {
      if (j >= hist.length) break;
      const s = document.createElement('span');
      s.textContent = hist[j];
      if (j === hist.length - 1) s.className = 'last';
      li.appendChild(s);
    }
    list.appendChild(li);
  }
  list.scrollTop = list.scrollHeight;
}

function renderGame() { renderBoard(); renderMoves(); updateButtons(); }

function updateSavedGame(id, fields) {
  const games = store.get('games', []);
  const g = games.find((x) => x.id === id);
  if (!g) return;
  Object.assign(g, fields);
  try {
    const c = new Chess();
    c.loadPgn(g.pgn);
    c.setHeader('Event', g.event || 'Casual game');
    c.setHeader('White', g.white || 'White');
    c.setHeader('Black', g.black || 'Black');
    g.pgn = c.pgn();
  } catch { /* keep the old PGN text if it can't be parsed */ }
  store.set('games', games);
}

function savedTitle(g) {
  return g.event && g.event !== 'Casual game' ? g.event : `${g.white} vs ${g.black}`;
}

function renderSaved() {
  renderFolder();
  const ul = $('saved');
  ul.innerHTML = '';
  for (const g of store.get('games', [])) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="info"><div class="title"></div><div class="meta"></div></div>
      <div class="acts"><button data-act="dl">PGN</button><button data-act="ren" class="ghost">Rename</button>
      <button data-act="del" class="ghost">Delete</button></div>`;
    li.querySelector('.title').textContent = `${savedTitle(g)} · ${g.result}`;
    li.querySelector('.meta').textContent =
      `${g.white} vs ${g.black} · ${new Date(g.date).toLocaleString()} · ${Math.ceil(g.moves / 2)} moves`;
    li.querySelector('[data-act="dl"]').onclick = () => download(g.pgn, g.file || pgnName(g.white, g.black, g.date, g.event));
    li.querySelector('[data-act="ren"]').onclick = () => editSaved(li, g);
    li.querySelector('[data-act="del"]').onclick = () => {
      if (!confirm('Delete this saved game?')) return;
      store.set('games', store.get('games', []).filter((x) => x.id !== g.id));
      renderSaved();
    };
    ul.appendChild(li);
  }
}

function editSaved(li, g) {
  li.innerHTML = `<form class="rename">
      <label>Game name <input name="event" placeholder="e.g. Club night round 3"></label>
      <label>White <input name="white"></label>
      <label>Black <input name="black"></label>
      <div class="acts"><button type="submit" class="primary">Save</button><button type="button" class="ghost">Cancel</button></div>
    </form>`;
  const f = li.querySelector('form');
  f.event.value = g.event && g.event !== 'Casual game' ? g.event : '';
  f.white.value = g.white;
  f.black.value = g.black;
  f.event.focus();
  f.querySelector('button[type="button"]').onclick = renderSaved;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const fields = {
      event: f.event.value.trim() || 'Casual game',
      white: f.white.value.trim() || 'White',
      black: f.black.value.trim() || 'Black',
    };
    const oldFile = g.file;
    fields.file = pgnName(fields.white, fields.black, g.date, fields.event);
    updateSavedGame(g.id, fields);
    renderSaved();
    let note = 'Game renamed.';
    if (folder.folderName() && oldFile) {
      const updated = store.get('games', []).find((x) => x.id === g.id);
      try {
        if (await folder.writeFile(updated.file, updated.pgn)) {
          if (oldFile !== updated.file) await folder.removeFile(oldFile);
          note += ` File is now ${updated.file}.`;
        }
      } catch { note += ' The file in the games folder was not updated.'; }
    }
    setStatus(note, 'ok');
  };
}

function showChoice(cands) {
  const box = $('choice');
  box.hidden = false;
  box.innerHTML = '<span>Which move?</span>';
  for (const m of cands) {
    const b = document.createElement('button');
    b.textContent = m.san;
    b.onclick = () => playMove(m);
    box.appendChild(b);
  }
}
function hideChoice() { $('choice').hidden = true; $('choice').innerHTML = ''; }

function updateButtons() {
  const ready = state.cams.length > 0 && state.cams.every((c) => c.sampler);
  $('btnTrack').disabled = !ready;
  $('btnTrack').textContent = state.tracking ? 'Pause tracking' : 'Start tracking';
  $('btnTrack').classList.toggle('primary', !state.tracking);
  $('btnUndo').disabled = state.game.history().length === 0;
}

function setTracking(on) {
  state.tracking = on && state.cams.length > 0 && state.cams.every((c) => c.sampler);
  state.stillSince = null;
  state.analysed = false;
  if (state.tracking) setStatus('Keep hands off the board for a moment while it reads the position…', 'busy');
  else if (on === false && state.cams.length) setStatus('Tracking paused.', 'idle');
  updateButtons();
}

// draw camera previews with overlays
function boardToCanvas(cam, x, y) {
  const [u, v] = applyH(cam.sampler.Hb2i, x, y);
  return [u * cam.canvas.width, v * cam.canvas.height];
}

function drawCams() {
  for (const cam of state.cams) {
    const { ctx, canvas, video } = cam;
    if (video.readyState >= 2) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (cam.sampler && !cam.calibrating) {
      if (settings.heatmap && cam.scores) {
        for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
          const s = cam.scores[squareIndex(f, r)];
          if (s < 0.05) continue;
          fillSquare(cam, f, r, `rgba(230,60,40,${Math.min(0.75, s)})`);
        }
      }
      const color = state.marks.kind === 'ok' ? 'rgba(60,200,90,0.45)' : 'rgba(230,70,50,0.5)';
      for (const name of state.marks.squares) {
        const i = sqIndex(name);
        fillSquare(cam, i % 8, Math.floor(i / 8), color);
      }
      ctx.strokeStyle = 'rgba(80,230,120,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 8; i++) {
        let [x1, y1] = boardToCanvas(cam, i, 0), [x2, y2] = boardToCanvas(cam, i, 8);
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        [x1, y1] = boardToCanvas(cam, 0, i); [x2, y2] = boardToCanvas(cam, 8, i);
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      }
      ctx.stroke();
      const [lx, ly] = boardToCanvas(cam, 0.5, 0.5);
      label(ctx, 'a1', lx, ly);
    }

    cam.corners.forEach(([x, y], i) => {
      const px = x * canvas.width, py = y * canvas.height;
      ctx.fillStyle = '#ff4d3a';
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
      label(ctx, CORNER_ORDER[i], px + 10, py - 10);
    });

    if (state.tracking && cam.sampler) {
      label(ctx, state.moving ? 'hand in view' : 'still', 10, 22, state.moving ? '#ffcc4d' : '#7dff9a');
    }
  }
  requestAnimationFrame(drawCams);
}

function fillSquare(cam, f, r, color) {
  const pts = [[f, r], [f + 1, r], [f + 1, r + 1], [f, r + 1]].map(([x, y]) => boardToCanvas(cam, x, y));
  const { ctx } = cam;
  ctx.fillStyle = color;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

function label(ctx, text, x, y, color = '#ffffff') {
  ctx.font = '600 14px system-ui, sans-serif';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function beep() {
  if (!settings.sound) return;
  try {
    state.audio ??= new AudioContext();
    const o = state.audio.createOscillator(), g = state.audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, state.audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, state.audio.currentTime + 0.15);
    o.connect(g).connect(state.audio.destination);
    o.start();
    o.stop(state.audio.currentTime + 0.15);
  } catch { /* sound is optional */ }
}

// ───────────────────────────────────────── settings UI

function bindSettings() {
  const fields = [
    ['settle', 'settleOut', (v) => `${v.toFixed(1)} s`],
    ['squareT', 'squareOut', (v) => `${Math.round(v * 100)}%`],
    ['pixelT', 'pixelOut', (v) => `${v}`],
    ['motionT', 'motionOut', (v) => `${(v * 100).toFixed(1)}%`],
  ];
  const sync = () => {
    for (const [id, out, fmt] of fields) { $(id).value = settings[id]; $(out).textContent = fmt(settings[id]); }
    $('sound').checked = settings.sound;
    $('heatmap').checked = settings.heatmap;
  };
  for (const [id, out, fmt] of fields) {
    $(id).addEventListener('input', () => {
      settings[id] = Number($(id).value);
      $(out).textContent = fmt(settings[id]);
      store.set('settings', settings);
    });
  }
  for (const id of ['sound', 'heatmap']) {
    $(id).addEventListener('change', () => { settings[id] = $(id).checked; store.set('settings', settings); });
  }
  $('btnResetSettings').onclick = () => { Object.assign(settings, DEFAULTS); store.set('settings', settings); sync(); };
  sync();
}

// ───────────────────────────────────────── wiring

function init() {
  restoreCurrent();
  bindSettings();
  renderGame();
  renderSaved();

  $('btnCameras').onclick = startCameras;
  for (const id of ['camA', 'camB']) $(id).addEventListener('change', saveCamChoice);
  const savedRes = store.get('resolution', null);
  if (savedRes && [...$('resolution').options].some((o) => o.value === savedRes)) $('resolution').value = savedRes;
  $('resolution').addEventListener('change', () => store.set('resolution', $('resolution').value));
  $('btnRefreshCams').onclick = () => listCameras(true).catch((e) => setStatus(e.message, 'warn'));
  $('btnTrack').onclick = () => setTracking(!state.tracking);
  $('btnUndo').onclick = undoMove;
  $('btnBaseline').onclick = rebaseline;
  $('btnFlip').onclick = () => { state.flipped = !state.flipped; store.set('flipped', state.flipped); renderBoard(); };
  $('btnDownload').onclick = () => {
    const h = headers();
    download(currentPgn(), pgnName(h.White, h.Black, store.get('current', {}).started || new Date().toISOString(), h.Event));
  };
  $('btnCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(currentPgn()); setStatus('PGN copied.', 'ok'); }
    catch { setStatus('Could not copy; use Download PGN instead.', 'warn'); }
  };
  $('btnSaveGame').onclick = saveAndNewGame;
  $('btnFolder').onclick = chooseFolder;
  $('btnExportAll').onclick = exportAll;
  folder.load().then(async (h) => {
    if (h) state.needsFolderPermission = !(await folder.ensurePermission(false));
    renderFolder();
  });
  for (const id of ['white', 'black', 'event']) $(id).addEventListener('change', saveCurrent);

  $('manualForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('manualMove').value.trim();
    if (text && playMove(text)) $('manualMove').value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); if (!$('btnTrack').disabled) setTracking(!state.tracking); }
    else if (k === 'u') undoMove();
    else if (k === 'b') rebaseline();
    else if (k === 'm') { e.preventDefault(); $('manualMove').focus(); }
  });

  listCameras(false).catch(() => {});
  navigator.mediaDevices?.addEventListener?.('devicechange', () => listCameras(false).catch(() => {}));
  setInterval(tick, TICK_MS);
  requestAnimationFrame(drawCams);
}

init();
