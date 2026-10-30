// app.js — wires cameras, calibration, detection and the game record to the page.
import { Chess } from 'chess.js';
import {
  CORNER_ORDER, buildSampler, sampleFrame, squareScores, motionFraction, combineScores, applyH, squareIndex,
} from './vision.js';
import { inferMove, touchedSquares, buildPgn, sqIndex, reconsiderLastMove } from './tracker.js';
import * as store from './storage.js';
import * as folder from './folder.js';
import {
  parseTimeControl, timedGame, summarize, totals, accuracyCsv, labelsCsv, clockState, formatClock,
} from './research.js';
import { material, sanToWords } from './boardinfo.js';
import { openingFor } from './openings.js';
import { pngBlob, gifBlob, openInLichess } from './share.js';
import { Engine } from './engine.js';
import { winPercent, formatEval, judgeMoves, reviewSummary } from './analysis.js';

const DEFAULTS = { settle: 1.0, squareT: 0.25, pixelT: 30, motionT: 0.004, sound: true, heatmap: false, dataset: true, timeControl: '', zoom: true, speak: false };
const WORK_W_MAX = 960; // max width of the image the detector analyses (more detail on far squares)
const TICK_MS = 100;    // detector runs ~10 times a second
const PIECE_NAME = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };

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
  prevRefs: null,
  stats: {},
  anaToken: 0,
  engine: null,
  meta: [],        // one entry per recorded move: where it came from, confidence, time
  events: [],      // everything that happened, including moves later undone or corrected
  clockStart: null,
  audio: null,
};

// ───────────────────────────────────────── status

function setStatus(text, kind = 'idle') {
  const el = $('status');
  if (el.textContent === text && el.classList.contains(kind)) return;
  el.textContent = text;
  el.title = text;
  el.className = `status ${kind}`;
  void el.offsetWidth; // restart the entrance animation
  el.classList.add('flash');
}

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ───────────────────────────────────────── setup drawer

function openDrawer(tab) {
  if (tab) selectTab(tab);
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('scrim').hidden = false;
  requestAnimationFrame(() => $('scrim').classList.add('open'));
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').classList.remove('open');
  setTimeout(() => { if (!$('drawer').classList.contains('open')) $('scrim').hidden = true; }, 260);
}

function selectTab(name) {
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
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
  if (state.cams.length) closeDrawer();
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
    corners: [], calibrating: false, adjusting: false, sampler: null, prev: null, cur: null, ref: null, motion: 1, scores: null,
    view: { x: 0, y: 0, w: 1, h: 1 }, hover: null, drag: -1,
  };
  el.querySelector('.cam-title').textContent = `Camera ${key}`;
  el.querySelector('.cam-state').textContent = `${label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)/i, '')}, ${vw}×${vh}`;

  const savedCorners = store.get('calib', {})[deviceId];
  if (savedCorners?.length === 4) applyCorners(cam, savedCorners);

  canvas.addEventListener('click', (e) => onCanvasClick(cam, e));
  canvas.addEventListener('pointermove', (e) => onCanvasMove(cam, e));
  canvas.addEventListener('pointerdown', (e) => onCanvasDown(cam, e));
  canvas.addEventListener('pointerup', (e) => onCanvasUp(cam, e));
  canvas.addEventListener('pointerleave', () => { cam.hover = null; });
  el.querySelector('.btn-calibrate').addEventListener('click', () => startCalibration(cam));
  el.querySelector('.btn-adjust').addEventListener('click', () => toggleAdjust(cam));
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

/** Pointer position as normalised video coordinates (0..1), allowing for the zoomed view. */
function pointerToVideo(cam, e) {
  const r = cam.canvas.getBoundingClientRect();
  const { x, y, w, h } = cam.view;
  return [x + ((e.clientX - r.left) / r.width) * w, y + ((e.clientY - r.top) / r.height) * h];
}

function onCanvasMove(cam, e) {
  if (!cam.calibrating && !cam.adjusting) return;
  cam.hover = pointerToVideo(cam, e);
  if (cam.drag >= 0) {
    cam.corners[cam.drag] = cam.hover;
    try { cam.sampler = buildSampler(cam.corners, cam.work.width, cam.work.height); } catch { /* corners crossing mid-drag */ }
  }
}

function onCanvasDown(cam, e) {
  if (!cam.adjusting) return;
  const [u, v] = pointerToVideo(cam, e);
  const r = cam.canvas.getBoundingClientRect();
  // nearest corner within ~18 screen pixels
  let best = -1, bestD = 18;
  cam.corners.forEach(([cu, cv], i) => {
    const d = Math.hypot((cu - u) / cam.view.w * r.width, (cv - v) / cam.view.h * r.height);
    if (d < bestD) { best = i; bestD = d; }
  });
  if (best >= 0) { cam.drag = best; cam.canvas.setPointerCapture(e.pointerId); }
}

function onCanvasUp(cam) {
  if (cam.drag < 0) return;
  cam.drag = -1;
  try {
    applyCorners(cam, cam.corners);
    saveCalibration(cam);
  } catch (err) {
    setStatus(`Those corners don't make a board (${err.message}). Drag them back into place.`, 'warn');
  }
}

function saveCalibration(cam) {
  const all = store.get('calib', {});
  all[cam.deviceId] = cam.corners;
  store.set('calib', all);
  for (const c of state.cams) { c.ref = null; c.prev = null; } // read the board afresh
  state.prevRefs = null;
}

function toggleAdjust(cam) {
  cam.adjusting = !cam.adjusting;
  if (cam.adjusting) setTracking(false);
  updateView(cam);
  updateCamHint(cam);
  updateButtons();
}

function onCanvasClick(cam, e) {
  if (!cam.calibrating || cam.corners.length >= 4) return;
  cam.corners.push(pointerToVideo(cam, e));
  if (cam.corners.length === 4) {
    try {
      applyCorners(cam, cam.corners);
      saveCalibration(cam);
      cam.calibrating = false;
      updateView(cam);
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
  updateView(cam);
}

/** Zoom the preview to the board once it's calibrated; show the whole picture while calibrating. */
function updateView(cam) {
  const vw = cam.video.videoWidth, vh = cam.video.videoHeight;
  let view = { x: 0, y: 0, w: 1, h: 1 };
  if (settings.zoom && cam.sampler && !cam.calibrating && !cam.adjusting && cam.corners.length === 4) {
    const xs = cam.corners.map((p) => p[0]), ys = cam.corners.map((p) => p[1]);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const mx = (x1 - x0) * 0.07, my = (y1 - y0) * 0.12; // a little room for tall pieces on the far rank
    x0 = Math.max(0, x0 - mx); x1 = Math.min(1, x1 + mx); y0 = Math.max(0, y0 - my * 1.6); y1 = Math.min(1, y1 + my);
    view = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  cam.view = view;
  const pw = view.w * vw, ph = view.h * vh;
  const cw = Math.round(Math.min(960, pw)), ch = Math.round((cw * ph) / pw);
  if (cam.canvas.width !== cw || cam.canvas.height !== ch) { cam.canvas.width = cw; cam.canvas.height = ch; }
}

function updateCamHint(cam) {
  const hint = cam.el.querySelector('.cam-hint');
  const undo = cam.el.querySelector('.btn-undo-point');
  cam.el.classList.toggle('calibrating', cam.calibrating);
  undo.hidden = !cam.calibrating || cam.corners.length === 0;
  cam.el.querySelector('.btn-calibrate').textContent = cam.sampler ? 'Recalibrate' : 'Calibrate';
  cam.el.querySelector('.btn-calibrate').hidden = cam.adjusting;
  const adj = cam.el.querySelector('.btn-adjust');
  adj.hidden = !cam.sampler || cam.calibrating;
  adj.textContent = cam.adjusting ? 'Done' : 'Adjust corners';
  cam.el.classList.toggle('adjusting', cam.adjusting);
  if (cam.adjusting) {
    hint.textContent = 'Drag the red corner dots onto the board corners';
  } else if (cam.calibrating) {
    hint.textContent = `Click the outer corner of ${CORNER_ORDER[cam.corners.length]} (${cam.corners.length + 1} of 4)`;
  } else if (cam.sampler) {
    hint.textContent = '';
  } else {
    hint.textContent = 'Press Calibrate, then click the four corners of the board';
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
  // Read the board once it settles, then re-check every 1.5 s while it stays still,
  // so a move that was read too early (or a slow, gentle move) is still picked up.
  if (settled && (!state.analysed || now - state.lastAnalysis > 1500)) {
    state.analysed = true;
    state.lastAnalysis = now;
    analyse(ready);
  }
}

function analyse(ready) {
  if (ready.some((c) => !c.ref)) {
    ready.forEach((c) => { c.ref = c.cur; });
    setStatus(`Watching the board. ${turnName()} to move.`, 'ok');
    capturePly(state.game.history().length, null, 'start', true); // photo of the starting position
    return;
  }
  // When the board went still, i.e. when the player let go of the piece.
  const settledAt = Date.now() - (performance.now() - (state.stillSince ?? performance.now()));
  const scores = combineScores(ready.map((c) => squareScores(c.ref, c.cur, c.sampler.per, settings.pixelT)));
  const r = inferMove(state.game, scores, { onT: settings.squareT, promotion: $('promotion').value });

  if (r.status === 'move') {
    playMove(r.move, { auto: true, source: r.weak ? 'weak' : 'auto', conf: r.score, at: settledAt });
  } else if ((r.status === 'nofit' || r.status === 'ambiguous') && tryCorrection(ready)) {
    // the last detected move was wrong and has been fixed
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

/**
 * The board no longer matches the record. Compare it with the image taken before the last
 * detected move: if a different move explains it, swap it in; if nothing really moved, drop it.
 */
function tryCorrection(ready) {
  const prev = state.prevRefs;
  if (!prev || prev.length !== state.cams.length || prev.some((r) => !r)) return false;
  const last = state.game.history({ verbose: true }).at(-1);
  if (!last) return false;
  const before = new Chess(last.before);
  const scores = combineScores(ready.map((c) => squareScores(prev[state.cams.indexOf(c)], c.cur, c.sampler.per, settings.pixelT)));
  const d = reconsiderLastMove(before, last.san, scores, { onT: settings.squareT, promotion: $('promotion').value });
  if (d.action === 'keep') return false;

  const ply = state.game.history().length;
  const popped = state.meta.pop();
  state.events.push({ type: d.action === 'replace' ? 'replaced' : 'dropped', san: last.san, source: popped?.source, ply, at: Date.now() });
  removePly(ply);
  state.game.undo();
  state.prevRefs = null;
  hideResult();
  hideChoice();
  state.stats.corrected = (state.stats.corrected || 0) + 1;
  if (d.action === 'replace') {
    playMove(d.move, { note: `Corrected ${last.san} to ${d.move.san}.`, source: 'corrected', at: popped?.at });
  } else {
    for (const c of state.cams) if (c.cur) c.ref = c.cur;
    state.marks = { squares: [], kind: 'ok' };
    saveCurrent();
    renderGame();
    setStatus(`Removed ${last.san}: nothing had really moved. ${turnName()} to move.`, 'busy');
  }
  return true;
}

// ───────────────────────────────────────── game

/** Remember where a move came from and how long it took (for the accuracy log and PGN times). */
function recordMove(res, opts) {
  const source = opts.source || 'manual';
  const at = opts.at ?? Date.now();
  const prevAt = state.meta.at(-1)?.at ?? state.clockStart ?? at;
  const conf = opts.conf != null ? Math.round(opts.conf * 1000) / 1000 : null;
  state.meta.push({ source, conf, at, emt: Math.max(0, at - prevAt) });
  const ply = state.game.history().length;
  state.events.push({ type: 'move', source, san: res.san, ply, conf, at });
  capturePly(ply, res.san, source);
}

function playMove(mv, opts = {}) {
  let res;
  try {
    res = state.game.move(typeof mv === 'string' ? mv : { from: mv.from, to: mv.to, promotion: mv.promotion });
  } catch {
    setStatus(`"${mv}" isn't a legal move here.`, 'warn');
    return false;
  }
  recordMove(res, opts);
  // Keep the image from before a detected move, so a misread can be corrected later.
  state.prevRefs = opts.auto ? state.cams.map((c) => c.ref) : null;
  state.marks = { squares: touchedSquares(res), kind: 'ok' };
  state.anim = [[res.from, res.to]];
  if (res.flags.includes('k')) state.anim.push(['h' + res.from[1], 'f' + res.from[1]]);
  if (res.flags.includes('q')) state.anim.push(['a' + res.from[1], 'd' + res.from[1]]);
  for (const c of state.cams) if (c.cur) c.ref = c.cur;
  state.pending = null;
  hideChoice();
  saveCurrent();
  renderGame();
  beep();
  speak((opts.note ? 'Correction. ' : '') + sanToWords(res.san));

  const num = Math.ceil(state.game.history().length / 2);
  let msg = `${opts.note ? opts.note + ' ' : ''}${num}${res.color === 'w' ? '.' : '…'} ${res.san} recorded. ${turnName()} to move.`;
  if (state.game.isGameOver()) {
    celebrate(res);
    return true;
  }
  setStatus(msg, 'ok');
  return true;
}

// ───────────────────────────────────────── game over

const PLAYER = (color) => (color === 'w' ? $('white').value || 'White' : $('black').value || 'Black');

function celebrate(lastMove) {
  const g = state.game;
  const mate = g.isCheckmate();
  const winner = lastMove.color; // the side that just moved delivered mate
  let kind = 'Draw', who = '', score = '½–½';
  if (mate) {
    kind = 'Checkmate';
    who = `${PLAYER(winner)} wins with ${lastMove.san}`;
    score = winner === 'w' ? '1–0' : '0–1';
  } else if (g.isStalemate()) { kind = 'Stalemate'; who = 'No legal moves, but no check.'; }
  else if (g.isThreefoldRepetition()) who = 'Threefold repetition.';
  else if (g.isInsufficientMaterial()) who = 'Not enough material to mate.';
  else who = 'Fifty-move rule.';

  setTracking(false);
  const ended = mate ? `Checkmate. ${PLAYER(winner)} wins ${score}.` : `${kind}. Game drawn.`;
  setStatus(`${ended} Game saved.`, 'ok');
  saveFinishedGame().then((note) => setStatus(`${ended} Game saved.${note}`, 'ok'));
  writeDataset().then(writeAccuracyFile);
  $('resultKind').textContent = kind;
  $('resultWho').textContent = who;
  $('resultScore').textContent = score;
  const box = $('result');
  box.classList.toggle('mate', mate);
  box.hidden = false;
  $('btnResultSave').focus({ preventScroll: true });
  if (mate) {
    fanfare();
    if (!reduceMotion()) confetti(winner);
  }
}

function hideResult() { $('result').hidden = true; }

function fanfare() {
  if (!settings.sound) return;
  try {
    state.audio ??= new AudioContext();
    const t0 = state.audio.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = state.audio.createOscillator(), gn = state.audio.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const t = t0 + i * 0.12;
      gn.gain.setValueAtTime(0.0001, t);
      gn.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + (i === 3 ? 0.9 : 0.25));
      o.connect(gn).connect(state.audio.destination);
      o.start(t);
      o.stop(t + 1);
    });
  } catch { /* sound is optional */ }
}

/** A short burst of confetti from the board, in board and piece colours. */
function confetti(winner) {
  const cv = document.createElement('canvas');
  cv.className = 'confetti';
  const dpr = devicePixelRatio || 1;
  cv.width = innerWidth * dpr;
  cv.height = innerHeight * dpr;
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const r = $('board').getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height * 0.45;
  const colors = winner === 'w'
    ? ['#fffdf8', '#ead7b5', '#c08a2d', '#e9c46a', '#a7774d']
    : ['#1f1712', '#5b3720', '#c08a2d', '#e9c46a', '#a7774d'];
  const parts = Array.from({ length: 180 }, () => {
    const a = Math.random() * Math.PI * 2, v = 6 + Math.random() * 12;
    return {
      x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 7,
      w: 6 + Math.random() * 7, h: 3 + Math.random() * 5, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
      c: colors[(Math.random() * colors.length) | 0], glyph: Math.random() < 0.06 ? '♚♛♞♜'[(Math.random() * 4) | 0] : null,
    };
  });
  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.985; p.vy *= 0.985;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t / 3200);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      if (p.glyph) { ctx.font = '22px serif'; ctx.fillText(p.glyph, -8, 8); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < 3300) requestAnimationFrame(frame); else cv.remove();
  })(start);
}

function undoMove() {
  if (state.review) return;
  const ply = state.game.history().length;
  const undone = state.game.undo();
  if (!undone) return;
  const popped = state.meta.pop();
  state.events.push({ type: 'undo', san: undone.san, source: popped?.source, ply, at: Date.now() });
  removePly(ply);
  state.prevRefs = null;
  hideResult();
  for (const c of state.cams) if (c.cur) c.ref = c.cur;
  state.marks = { squares: [], kind: 'ok' };
  hideChoice();
  saveCurrent();
  renderGame();
  setStatus(`Undid ${undone.san}. Make sure the board matches, then carry on.`, 'busy');
}

function rebaseline() {
  for (const c of state.cams) if (c.cur) c.ref = c.cur;
  state.prevRefs = null;
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

/** The game as PGN, with the time each move took (and clock times when a time control is set). */
function currentPgn() {
  const g = timedGame(state.game, state.meta.map((m) => m.emt), parseTimeControl(settings.timeControl));
  return buildPgn(g, headers());
}

let autosaveChain = Promise.resolve();

/** Remember the game in the browser and, if a games folder is set, write it there after every move. */
function saveCurrent() {
  const cur = store.get('current', {});
  const n = state.game.history().length;
  const now = new Date().toISOString();
  // A game's time is when its first move is played, not when the page or New game was opened.
  const started = n > 0 && !cur.playing ? now : (cur.started || now);
  const ended = n > 0 ? now : cur.ended;
  const id = cur.id || Date.now();
  const white = $('white').value, black = $('black').value, event = $('event').value;
  const file = pgnName(white || 'White', black || 'Black', started, event || 'Casual game');
  const downloaded = state.game.isGameOver() ? cur.downloaded : false; // re-download if a finished game changes
  store.set('current', {
    ...cur, id, started, ended, playing: n > 0, pgn: state.game.pgn(), white, black, event, file, downloaded,
    meta: state.meta, events: state.events,
  });
  upsertCurrentGame();
  if (n || cur.playing) {
    autosaveChain = autosaveChain.then(() => autosave(file, cur.file)).catch((err) => console.warn('Autosave failed', err));
  }
}

/** Keep the game in progress in the Saved games list, so every game is saved without pressing anything. */
function upsertCurrentGame(final = false) {
  const cur = store.get('current', {});
  if (!cur.id) return;
  let games = store.get('games', []).filter((g) => g.id !== cur.id);
  const n = state.game.history().length;
  if (n) {
    const h = headers();
    const pgn = currentPgn();
    games.unshift({
      id: cur.id, date: cur.started, ended: cur.ended, white: h.White, black: h.Black, event: h.Event,
      result: pgn.match(/\[Result "([^"]+)"\]/)?.[1] ?? '*', moves: n, pgn, file: cur.file,
      inProgress: !final && !state.game.isGameOver(),
      meta: state.meta, events: state.events, summary: summarize(state.meta, state.events),
      dataDir: cur.dataset?.dir, cameras: state.cams.length || cur.cameras,
    });
  }
  if (!store.set('games', games)) setStatus('This browser is out of storage space. Choose a games folder to keep saving.', 'warn');
  renderSaved();
}

/** When a game ends without a games folder, download its PGN once so it's on disk. */
async function saveFinishedGame() {
  await autosaveChain;
  const cur = store.get('current', {});
  if (folder.folderName() || cur.downloaded || !state.game.history().length) return '';
  download(currentPgn(), cur.file);
  store.set('current', { ...cur, downloaded: true });
  return ` Downloaded ${cur.file}.`;
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
  const n = state.game.history().length;
  state.meta = (cur.meta || []).slice(0, n);
  while (state.meta.length < n) state.meta.push({ source: 'unknown' });
  state.events = cur.events || [];
}

async function saveAndNewGame() {
  let note = 'New game.';
  if (state.game.history().length) {
    upsertCurrentGame(true);
    note = 'Previous game saved.' + (folder.folderName()
      ? ` It's in ${folder.folderName()}/${store.get('current', {}).file}.`
      : await saveFinishedGame());
  }
  if (state.game.history().length) await writeDataset(); // final labels and log for the finished game
  writeAccuracyFile();
  state.game = new Chess();
  state.prevRefs = null;
  state.meta = [];
  state.events = [];
  state.flagged = null;
  state.clockStart = state.tracking ? Date.now() : null;
  const started = new Date().toISOString();
  $('event').value = ''; // a new game gets its own name; players carry over
  store.set('current', { id: Date.now(), started, pgn: '', white: $('white').value, black: $('black').value, event: '' });
  state.autosavedFile = null;
  hideResult();
  for (const c of state.cams) if (c.cur) c.ref = c.cur;
  state.marks = { squares: [], kind: 'ok' };
  hideChoice();
  renderGame();
  renderSaved();
  setStatus(`${note} Set up the pieces for a new game.`, 'ok');
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
  $('folderLine').textContent = !name ? 'No games folder yet. Choose one in Setup, Games.'
    : state.needsFolderPermission ? `Saving to "${name}" is paused. Open Setup, Games and press Allow.`
      : `Auto-saving to ${name}${state.autosavedFile ? `/${state.autosavedFile}` : ''}`;
}

function openMenu() { $('exportMenu').hidden = false; $('btnExport').setAttribute('aria-expanded', 'true'); }
function closeMenu() { $('exportMenu').hidden = true; $('btnExport').setAttribute('aria-expanded', 'false'); }

/** The game on screen: the live game, or the saved game being reviewed. */
function viewedGameInfo() {
  if (state.review) {
    const g = state.review.meta;
    return { pgn: g.pgn, file: g.file || pgnName(g.white, g.black, g.date, g.event), moves: state.review.moves, white: g.white, black: g.black, start: state.review.start };
  }
  const h = headers();
  return {
    pgn: currentPgn(), file: pgnName(h.White, h.Black, store.get('current', {}).started || new Date().toISOString(), h.Event),
    moves: state.game.history({ verbose: true }), white: h.White, black: h.Black,
  };
}

async function exportPng() {
  closeMenu();
  const v = viewedGameInfo();
  const g = viewGame();
  const ply = state.review ? state.review.ply : v.moves.length;
  const last = v.moves[ply - 1];
  const caption = `${v.white} vs ${v.black}${last ? `, ${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'} ${last.san}` : ''}`;
  const blob = await pngBlob(g.board(), { flipped: state.flipped, marks: last ? [last.from, last.to] : [], caption });
  download(blob, v.file.replace(/\.pgn$/, `_move${ply}.png`));
  setStatus('Board image saved to Downloads.', 'ok');
}

async function exportGif() {
  closeMenu();
  const v = viewedGameInfo();
  if (!v.moves.length) { setStatus('Play a few moves first.', 'idle'); return; }
  const g = v.start ? new Chess(v.start) : new Chess(v.moves[0].before);
  const frames = [{ board: g.board(), marks: [], caption: `${v.white} vs ${v.black}` }];
  v.moves.forEach((m, i) => {
    g.move(m.san);
    frames.push({ board: g.board(), marks: [m.from, m.to], caption: `${Math.ceil((i + 1) / 2)}${i % 2 ? '…' : '.'} ${m.san}` });
  });
  const blob = await gifBlob(frames, {
    flipped: state.flipped,
    onProgress: (i, n) => setStatus(`Making the animation… ${Math.round((i / n) * 100)}%`, 'busy'),
  });
  download(blob, v.file.replace(/\.pgn$/, '.gif'));
  setStatus('Game animation saved to Downloads.', 'ok');
}

function download(data, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: 'application/x-chess-pgn' }));
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
  const g = viewGame();
  const rows = g.board(); // rows[0] is rank 8
  const lit = new Set(state.review ? state.review.marks : state.marks.kind === 'ok' ? state.marks.squares : []);
  for (let vr = 0; vr < 8; vr++) {
    for (let vf = 0; vf < 8; vf++) {
      const rank = state.flipped ? vr : 7 - vr;    // 0 = rank 1
      const file = state.flipped ? 7 - vf : vf;
      const p = rows[7 - rank][file];
      const name = 'abcdefgh'[file] + (rank + 1);
      const sq = document.createElement('div');
      sq.dataset.sq = name;
      sq.className = `sq ${(file + rank) % 2 ? 'light' : 'dark'}${lit.has(name) ? ' hl' : ''}`;
      if (p) {
        let extra = '';
        if (p.type === 'k' && g.isCheckmate()) extra = p.color === g.turn() ? ' mated' : ' victor';
        sq.innerHTML = `<span class="pc ${p.color}${p.type.toUpperCase()}${extra}" role="img" aria-label="${p.color === 'w' ? 'White' : 'Black'} ${PIECE_NAME[p.type]}"></span>`;
      }
      if (vr === 7) sq.insertAdjacentHTML('beforeend', `<span class="coord file">${'abcdefgh'[file]}</span>`);
      if (vf === 0) sq.insertAdjacentHTML('beforeend', `<span class="coord rank">${rank + 1}</span>`);
      board.appendChild(sq);
    }
  }
  animatePieces(board);
}

/** Slide the piece(s) of the last move from their old square to the new one. */
function animatePieces(board) {
  const moves = state.anim;
  state.anim = null;
  if (!moves || reduceMotion()) return;
  for (const [from, to] of moves) {
    const a = board.querySelector(`[data-sq="${from}"]`)?.getBoundingClientRect();
    const target = board.querySelector(`[data-sq="${to}"]`);
    const pc = target?.querySelector('.pc');
    if (!a || !pc) continue;
    const b = target.getBoundingClientRect();
    pc.style.zIndex = 3;
    pc.animate(
      [{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(1.08)` }, { transform: 'none' }],
      { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' },
    ).onfinish = () => { pc.style.zIndex = ''; };
  }
}

function renderMoves() {
  const list = $('moves');
  const rv = state.review;
  const hist = rv ? rv.moves.map((m) => m.san) : state.game.history();
  const current = rv ? rv.ply - 1 : hist.length - 1;
  list.innerHTML = '';
  for (let i = 0; i < hist.length; i += 2) {
    const li = document.createElement('li');
    for (const j of [i, i + 1]) {
      if (j >= hist.length) break;
      const s = document.createElement('span');
      s.textContent = hist[j];
      const jm = rv?.judged?.[j];
      if (jm?.mark) s.insertAdjacentHTML('beforeend', `<span class="mk mk-${jm.label}" title="${jm.label}">${jm.mark}</span>`);
      if (j === current) s.className = 'last';
      if (rv) { s.classList.add('jump'); s.onclick = () => reviewGoto(j + 1); }
      li.appendChild(s);
    }
    list.appendChild(li);
  }
  const cur = list.querySelector('.last');
  if (rv && cur) cur.scrollIntoView({ block: 'nearest' });
  else list.scrollTop = list.scrollHeight;
}

// ───────────────────────────────────────── research data

let datasetChain = Promise.resolve();
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stampOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/**
 * Save a photo from every camera showing the board right now, labelled with the exact position.
 * Files go to <games folder>/<game date-time>/cam-A/ply-012.jpg. The frames and position are taken
 * immediately; writing happens in the background, one file at a time.
 */
function capturePly(ply, san, source, onlyIfMissing = false) {
  if (!settings.dataset || !folder.folderName() || state.review) return;
  const cams = state.cams.filter((c) => c.video.readyState >= 2 && c.video.videoWidth);
  if (!cams.length) return;
  const fen = state.game.fen();
  const at = new Date().toISOString();
  // Grab the frames now, before anything else can change on the board.
  const shots = cams.map((c) => {
    const cv = document.createElement('canvas');
    cv.width = c.video.videoWidth;
    cv.height = c.video.videoHeight;
    cv.getContext('2d').drawImage(c.video, 0, 0);
    return { key: c.key, blob: new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9)) };
  });
  datasetChain = datasetChain.then(async () => {
    if (!(await folder.ensurePermission(false))) { state.needsFolderPermission = true; renderFolder(); return; }
    const cur = store.get('current', {});
    const ds = cur.dataset || { dir: stampOf(new Date()), entries: [] };
    if (onlyIfMissing && ds.entries.some((e) => e.ply === ply)) return;
    const images = {};
    for (const sh of shots) {
      const path = `cam-${sh.key}/ply-${pad(ply, 3)}.jpg`;
      const blob = await sh.blob;
      if (blob && await folder.writeFile(`${ds.dir}/${path}`, blob)) images[sh.key] = path;
    }
    ds.entries = ds.entries.filter((e) => e.ply !== ply);
    ds.entries.push({ ply, san, fen, source, at, images });
    ds.entries.sort((a, b) => a.ply - b.ply);
    store.set('current', { ...store.get('current', {}), dataset: ds, cameras: state.cams.length });
    await writeDatasetFiles();
  }).catch((err) => console.warn('Dataset photo failed', err));
}

/** A move was undone or corrected: its photos no longer show a real position, so remove them. */
function removePly(ply) {
  datasetChain = datasetChain.then(async () => {
    const cur = store.get('current', {});
    const ds = cur.dataset;
    if (!ds || !folder.folderName()) return;
    for (const e of ds.entries.filter((x) => x.ply >= ply)) {
      for (const path of Object.values(e.images || {})) await folder.removeFile(`${ds.dir}/${path}`);
    }
    ds.entries = ds.entries.filter((x) => x.ply < ply);
    store.set('current', { ...cur, dataset: ds });
    await writeDatasetFiles();
  }).catch((err) => console.warn('Dataset cleanup failed', err));
}

/** labels.json / labels.csv (what each photo shows), log.json (every detection) and a copy of the game. */
async function writeDatasetFiles() {
  const cur = store.get('current', {});
  const ds = cur.dataset;
  if (!ds || !folder.folderName()) return;
  const h = headers();
  const cameras = state.cams.map((c) => ({
    key: c.key, label: c.label, width: c.video.videoWidth, height: c.video.videoHeight,
    corners: { order: CORNER_ORDER, points: c.corners }, // normalised 0..1 image coordinates
  }));
  const labels = {
    format: 'chess-cam-tracker dataset v1',
    note: 'Each image shows the board after `ply` half-moves; `fen` is the exact position. Corners are the calibrated outer corners of the playing area (a1, h1, h8, a8) in normalised image coordinates.',
    game: { event: h.Event, white: h.White, black: h.Black, started: cur.started },
    cameras,
    positions: ds.entries,
  };
  await folder.writeFile(`${ds.dir}/labels.json`, JSON.stringify(labels, null, 2));
  await folder.writeFile(`${ds.dir}/labels.csv`, labelsCsv(ds.entries));
  await folder.writeFile(`${ds.dir}/log.json`, JSON.stringify({
    summary: summarize(state.meta, state.events),
    moves: state.game.history().map((san, i) => ({ ply: i + 1, san, ...state.meta[i] })),
    events: state.events,
    settings: { ...settings },
  }, null, 2));
  if (state.game.history().length) await folder.writeFile(`${ds.dir}/game.pgn`, currentPgn());
}

function writeDataset() {
  datasetChain = datasetChain.then(writeDatasetFiles).catch((err) => console.warn('Dataset write failed', err));
  return datasetChain;
}

/** accuracy.csv in the games folder: one row per game. */
async function writeAccuracyFile() {
  if (!folder.folderName() || !(await folder.ensurePermission(false))) return;
  try { await folder.writeFile('accuracy.csv', accuracyCsv(store.get('games', []))); } catch { /* not essential */ }
}

function renderAccuracy() {
  const games = store.get('games', []).filter((g) => g.summary?.moves);
  const t = totals(games.map((g) => g.summary));
  const pct = (x) => `${Math.round(x * 100)}%`;
  $('accuracy').textContent = t.moves
    ? `Across ${t.games} game${t.games === 1 ? '' : 's'}, ${t.unaided} of ${t.moves} moves (${pct(t.unaidedRate)}) were recorded without help. ` +
      `${t.misreads} misread${t.misreads === 1 ? '' : 's'}: ${t.selfFixed} fixed by the app, ${t.undone} undone by hand.`
    : 'Accuracy numbers appear here once games are played with the cameras.';
  const s = summarize(state.meta, state.events);
  $('gameStats').textContent = s.moves ? `This game: ${s.unaided} of ${s.moves} moves without help (${pct(s.unaidedRate)})` : '';
}

// ───────────────────────────────────────── reviewing saved games

const viewGame = () => (state.review ? state.review.view : state.game);

function openReview(g) {
  const full = new Chess();
  try { full.loadPgn(g.pgn); } catch { setStatus('That game could not be opened.', 'warn'); return; }
  const moves = full.history({ verbose: true });
  setTracking(false);
  closeDrawer();
  hideResult();
  hideChoice();
  state.review = { meta: g, moves, ply: moves.length, start: moves[0]?.before, marks: [] };
  document.body.classList.add('reviewing');
  $('white').value = g.white; $('black').value = g.black;
  $('white').readOnly = $('black').readOnly = true;
  $('reviewTitle').textContent = `${savedTitle(g)}, ${g.inProgress ? 'in progress' : g.result === '*' ? 'unfinished' : g.result}`;
  reviewGoto(moves.length);
  setStatus('Reviewing a saved game. Use the arrow keys to step through it.', 'idle');
  analyseReview();
}

function reviewGoto(ply) {
  const rv = state.review;
  if (!rv) return;
  ply = Math.max(0, Math.min(rv.moves.length, ply));
  const step = ply - rv.ply;
  const view = rv.start ? new Chess(rv.start) : new Chess();
  for (let i = 0; i < ply; i++) view.move(rv.moves[i].san);
  rv.view = view;
  rv.ply = ply;
  const m = rv.moves[ply - 1];
  rv.marks = m ? [m.from, m.to] : [];
  if (step === 1 && m) state.anim = [[m.from, m.to]];
  $('rvLabel').textContent = ply ? `Move ${Math.ceil(ply / 2)}${ply % 2 ? '' : '…'} ${m.san}` : 'Start position';
  $('rvPrev').disabled = $('rvFirst').disabled = ply === 0;
  $('rvNext').disabled = $('rvLast').disabled = ply === rv.moves.length;
  renderBoard();
  renderMoves();
  renderInfo();
  renderEval();
}

// ───────────────────────────────────────── Stockfish review

function endFen(fen) {
  const g = new Chess(fen);
  if (g.isCheckmate()) return g.turn() === 'w' ? { over: -1, text: '0-1' } : { over: 1, text: '1-0' };
  if (g.isGameOver()) return { over: 0, text: '½-½' };
  return null;
}

/** Evaluate every position of the reviewed game (cached with the saved game), marking mistakes as it goes. */
async function analyseReview() {
  const rv = state.review;
  if (!rv || !rv.moves.length) return;
  const g = rv.meta;
  const fens = [rv.start || rv.moves[0].before, ...rv.moves.map((m) => m.after)];
  if (g.analysis?.evals?.length === fens.length) {
    rv.evals = g.analysis.evals;
    finishAnalysis(rv);
    return;
  }
  const token = ++state.anaToken;
  try {
    state.engine ??= new Engine();
  } catch {
    $('analysisLine').textContent = 'The analysis engine could not start in this browser.';
    return;
  }
  rv.evals = [];
  for (let i = 0; i < fens.length; i++) {
    if (token !== state.anaToken) return; // the review was closed or another game opened
    $('analysisLine').textContent = `Stockfish is analysing: position ${i + 1} of ${fens.length}`;
    rv.evals.push(endFen(fens[i]) || await state.engine.analyse(fens[i]));
    rv.judged = judgeMoves(rv.evals);
    if (i === rv.ply || i === rv.ply - 1) renderEval();
    if (i % 4 === 0) renderMoves();
  }
  if (token !== state.anaToken) return;
  // keep the result with the saved game so it opens instantly next time
  const games = store.get('games', []);
  const saved = games.find((x) => x.id === g.id);
  if (saved) { saved.analysis = { engine: 'Stockfish 19 lite', evals: rv.evals }; store.set('games', games); g.analysis = saved.analysis; }
  finishAnalysis(rv);
}

function finishAnalysis(rv) {
  rv.judged = judgeMoves(rv.evals);
  const s = reviewSummary(rv.judged);
  const side = (x) => [x.blunders && `${x.blunders} blunder${x.blunders > 1 ? 's' : ''}`,
    x.mistakes && `${x.mistakes} mistake${x.mistakes > 1 ? 's' : ''}`,
    x.inaccuracies && `${x.inaccuracies} inaccurac${x.inaccuracies > 1 ? 'ies' : 'y'}`].filter(Boolean).join(', ') || 'no mistakes';
  $('analysisLine').textContent =
    `Accuracy: White ${s.w.accuracy ?? '–'}%, Black ${s.b.accuracy ?? '–'}%. White: ${side(s.w)}. Black: ${side(s.b)}.`;
  renderMoves();
  renderEval();
}

/** Evaluation bar and the engine's best move for the position on screen. */
function renderEval() {
  const rv = state.review;
  const bar = $('evalbar'), arrow = $('bestArrow');
  const ev = rv?.evals?.[rv.ply];
  arrow.style.display = 'none';
  bar.classList.toggle('flipped', state.flipped);
  if (!ev) { bar.querySelector('.evalfill').style.height = '50%'; bar.querySelector('.evaltext').textContent = ''; return; }
  const pct = ev.over != null ? 50 + 50 * ev.over : winPercent(ev);
  bar.querySelector('.evalfill').style.height = `${pct}%`;
  bar.querySelector('.evaltext').textContent = ev.text || formatEval(ev);
  bar.classList.toggle('black-ahead', pct < 50);
  if (ev.best) {
    const xy = (sq) => {
      const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
      return state.flipped ? [7 - f + 0.5, r + 0.5] : [f + 0.5, 7 - r + 0.5];
    };
    const [x1, y1] = xy(ev.best.slice(0, 2)), [x2, y2] = xy(ev.best.slice(2, 4));
    const k = 0.28 / Math.hypot(x2 - x1, y2 - y1); // stop short of the target square's centre
    Object.entries({ x1, y1, x2: x2 - (x2 - x1) * k, y2: y2 - (y2 - y1) * k }).forEach(([a, v]) => arrow.setAttribute(a, v));
    arrow.style.display = '';
  }
}

function exitReview() {
  if (!state.review) return;
  state.anaToken++;
  state.engine?.stop();
  $('bestArrow').style.display = 'none';
  state.review = null;
  document.body.classList.remove('reviewing');
  const cur = store.get('current', {});
  $('white').value = cur.white || ''; $('black').value = cur.black || '';
  $('white').readOnly = $('black').readOnly = false;
  renderGame();
  setStatus('Back to the live game.', 'ok');
}

function renderGame() { renderBoard(); renderMoves(); renderInfo(); updateButtons(); }

// ───────────────────────────────────────── opening, material, clock, speech

let OPENINGS = null;
fetch('vendor/openings.json').then((r) => r.json()).then((t) => { OPENINGS = t; renderInfo(); }).catch(() => {});

/** Positions after each move of whatever is on screen (the live game, or a reviewed game up to the current move). */
function viewFens() {
  return state.review
    ? state.review.moves.slice(0, state.review.ply).map((m) => m.after)
    : state.game.history({ verbose: true }).map((m) => m.after);
}

function renderInfo() {
  const g = viewGame();
  const m = material(g.board());
  for (const [side, el] of [['w', $('capW')], ['b', $('capB')]]) {
    const theirs = side === 'w' ? 'b' : 'w';
    const lead = side === 'w' ? m.diff : -m.diff;
    el.innerHTML = m.capturedBy[side].map((t) => `<i class="cap ${theirs}${t.toUpperCase()}"></i>`).join('') +
      (lead > 0 ? `<span class="diff">+${lead}</span>` : '');
  }
  const o = OPENINGS && openingFor(viewFens(), OPENINGS);
  $('opening').innerHTML = o ? `<b>${o.eco}</b>${o.name.replace(/[<>&]/g, '')}` : '';
  renderClocks();
}

/** On-screen chess clock, driven by the recorded move times (only when a time control is set). */
function renderClocks() {
  const tc = parseTimeControl(settings.timeControl);
  const show = !!tc && !state.review;
  $('clockW').hidden = $('clockB').hidden = !show;
  if (!show) return;
  const over = state.game.isGameOver();
  const now = over ? (state.meta.at(-1)?.at ?? Date.now()) : Date.now();
  const c = clockState(state.meta, tc, state.game.turn(), now, state.clockStart);
  for (const [side, el] of [['w', $('clockW')], ['b', $('clockB')]]) {
    const ms = c[side];
    el.textContent = ms >= 3600_000 ? formatClock(ms) : formatClock(ms).slice(2);
    el.classList.toggle('running', c.running === side && !over);
    el.classList.toggle('low', ms < 20_000);
  }
  const flagged = ['w', 'b'].find((side) => c[side] === 0);
  if (flagged && !over && state.flagged !== flagged) {
    state.flagged = flagged;
    setStatus(`${PLAYER(flagged)} has run out of time.`, 'warn');
  }
}
setInterval(() => { if (!document.hidden) renderClocks(); }, 250);

function speak(text) {
  if (!settings.speak || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

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

/** "30 Oct, 12:20 to 12:27" from the first and last move times. */
function playedAt(g) {
  const s = new Date(g.date), e = g.ended ? new Date(g.ended) : null;
  const day = s.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const t = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return e && t(e) !== t(s) ? `${day}, ${t(s)} to ${t(e)}` : `${day}, ${t(s)}`;
}

function renderSaved() {
  renderFolder();
  renderAccuracy();
  const ul = $('saved');
  ul.innerHTML = '';
  for (const g of store.get('games', [])) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="info"><div class="title"></div><div class="meta"></div></div>
      <div class="acts"><button data-act="open" class="primary">Open</button><button data-act="dl">PGN</button><button data-act="ren" class="ghost">Rename</button>
      <button data-act="del" class="ghost">Delete</button></div>`;
    li.querySelector('.title').textContent = `${savedTitle(g)}  ${g.inProgress ? '(in progress)' : g.result === '*' ? '(unfinished)' : g.result}`;
    li.querySelector('.meta').textContent =
      `${g.white} vs ${g.black}, ${Math.ceil(g.moves / 2)} move${Math.ceil(g.moves / 2) === 1 ? '' : 's'}, ${playedAt(g)}` +
      (g.summary?.moves ? `, ${Math.round(g.summary.unaidedRate * 100)}% detected without help` : '');
    li.querySelector('[data-act="open"]').onclick = () => openReview(g);
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
    if (g.id === store.get('current', {}).id) {
      $('white').value = fields.white === 'White' ? '' : fields.white;
      $('black').value = fields.black === 'Black' ? '' : fields.black;
      $('event').value = fields.event === 'Casual game' ? '' : fields.event;
      saveCurrent();
    }
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
    b.onclick = () => playMove(m, { source: 'choice' });
    box.appendChild(b);
  }
}
function hideChoice() { $('choice').hidden = true; $('choice').innerHTML = ''; }

function updateButtons() {
  const ready = state.cams.length > 0 && state.cams.every((c) => c.sampler);
  const btn = $('btnTrack');
  btn.disabled = !ready;
  btn.classList.toggle('on', state.tracking);
  btn.innerHTML = state.tracking
    ? '<svg><use href="#i-pause"/></svg><span>Pause</span>'
    : '<svg><use href="#i-play"/></svg><span>Start tracking</span>';
  $('live').hidden = !state.tracking;
  $('btnUndo').disabled = state.game.history().length === 0;
}

function setTracking(on) {
  if (on && state.review) exitReview();
  state.tracking = on && state.cams.length > 0 && state.cams.every((c) => c.sampler);
  // The first move's time is measured from when tracking starts.
  if (state.tracking && !state.game.history().length) state.clockStart = Date.now();
  state.stillSince = null;
  state.analysed = false;
  if (state.tracking) setStatus('Keep hands off the board for a moment while it reads the position…', 'busy');
  else if (on === false && state.cams.length) setStatus('Tracking paused.', 'idle');
  updateButtons();
}

// draw camera previews with overlays
/** Normalised video coordinates -> canvas pixels, allowing for the zoomed view. */
function toCanvas(cam, u, v) {
  const { x, y, w, h } = cam.view;
  return [((u - x) / w) * cam.canvas.width, ((v - y) / h) * cam.canvas.height];
}

function boardToCanvas(cam, x, y) {
  const [u, v] = applyH(cam.sampler.Hb2i, x, y);
  return toCanvas(cam, u, v);
}

/** A round magnifier showing the video around the pointer, for placing corners precisely. */
function drawMagnifier(cam) {
  const { ctx, canvas, video, hover } = cam;
  if (!hover || (!cam.calibrating && !cam.adjusting) || video.readyState < 2) return;
  const R = Math.round(Math.min(canvas.width, canvas.height) * 0.16), zoom = 4;
  const vw = video.videoWidth, vh = video.videoHeight;
  const [px, py] = toCanvas(cam, hover[0], hover[1]);
  // keep the lens away from the pointer
  const cx = px > canvas.width / 2 ? R + 12 : canvas.width - R - 12, cy = R + 44;
  const srcW = (2 * R / canvas.width) * cam.view.w * vw / zoom, srcH = (2 * R / canvas.height) * cam.view.h * vh / zoom;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = '#000'; ctx.fill(); ctx.clip();
  ctx.drawImage(video, hover[0] * vw - srcW / 2, hover[1] * vh - srcH / 2, srcW, srcH, cx - R, cy - R, 2 * R, 2 * R);
  ctx.strokeStyle = '#ff4d3a'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  ctx.restore();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2; ctx.stroke();
}

function drawCams() {
  for (const cam of state.cams) {
    const { ctx, canvas, video } = cam;
    if (video.readyState >= 2) {
      const { x, y, w, h } = cam.view, vw = video.videoWidth, vh = video.videoHeight;
      ctx.drawImage(video, x * vw, y * vh, w * vw, h * vh, 0, 0, canvas.width, canvas.height);
    }

    if (cam.sampler && !cam.calibrating) {
      if (settings.heatmap && cam.scores && !cam.adjusting) {
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

    if (cam.calibrating || cam.adjusting) {
      cam.corners.forEach(([x, y], i) => {
        const [px, py] = toCanvas(cam, x, y);
        ctx.fillStyle = cam.drag === i ? '#ffd166' : '#ff4d3a';
        ctx.beginPath(); ctx.arc(px, py, cam.adjusting ? 8 : 6, 0, Math.PI * 2); ctx.fill();
        label(ctx, CORNER_ORDER[i], px + 10, py - 10);
      });
      drawMagnifier(cam);
    }

    if (state.tracking && cam.sampler) {
      label(ctx, state.moving ? 'hand in view' : 'still', 12, canvas.height - 14, state.moving ? '#ffcc4d' : '#7dff9a');
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
    $('dataset').checked = settings.dataset;
    $('zoom').checked = settings.zoom;
    $('speak').checked = settings.speak;
    $('timeControl').value = settings.timeControl;
  };
  for (const [id, out, fmt] of fields) {
    $(id).addEventListener('input', () => {
      settings[id] = Number($(id).value);
      $(out).textContent = fmt(settings[id]);
      store.set('settings', settings);
    });
  }
  for (const id of ['sound', 'heatmap', 'dataset', 'zoom', 'speak']) {
    $(id).addEventListener('change', () => { settings[id] = $(id).checked; store.set('settings', settings); });
  }
  $('timeControl').addEventListener('change', () => {
    const v = $('timeControl').value.trim();
    if (v && !parseTimeControl(v)) { setStatus('Write the time control as minutes+seconds, for example 10+5.', 'warn'); return; }
    settings.timeControl = v;
    store.set('settings', settings);
    saveCurrent(); // rewrite the game file with clock times
  });
  $('zoom').addEventListener('change', () => state.cams.forEach(updateView));
  $('btnExportAccuracy').onclick = () => download(accuracyCsv(store.get('games', [])), 'accuracy.csv');
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
  $('btnFlip').onclick = () => { state.flipped = !state.flipped; store.set('flipped', state.flipped); renderBoard(); renderEval(); };
  $('btnDownload').onclick = () => { closeMenu(); const v = viewedGameInfo(); download(v.pgn, v.file); };
  $('btnCopy').onclick = async () => {
    closeMenu();
    try { await navigator.clipboard.writeText(viewedGameInfo().pgn); setStatus('PGN copied.', 'ok'); }
    catch { setStatus('Could not copy; use Download PGN instead.', 'warn'); }
  };
  $('btnExport').onclick = (e) => { e.stopPropagation(); $('exportMenu').hidden ? openMenu() : closeMenu(); };
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeMenu(); });
  $('btnPng').onclick = exportPng;
  $('btnGif').onclick = exportGif;
  $('btnLichess').onclick = async () => {
    const v = viewedGameInfo();
    if (!v.moves.length) { setStatus('Play a few moves first.', 'idle'); return; }
    setStatus('Sending the game to Lichess…', 'busy');
    const how = await openInLichess(v.pgn);
    setStatus(how === 'opened' ? 'Opened on Lichess for analysis.' : 'Lichess did not answer, so the PGN was copied. Paste it into the page that opened.', how === 'opened' ? 'ok' : 'busy');
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
    if (text && playMove(text, { source: 'manual' })) $('manualMove').value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input:not([readonly]), select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (state.review) {
      const rv = state.review, keys = { arrowleft: rv.ply - 1, arrowright: rv.ply + 1, home: 0, end: rv.moves.length };
      if (k in keys) { e.preventDefault(); reviewGoto(keys[k]); return; }
      if (k === 'escape' && !$('drawer').classList.contains('open')) { exitReview(); return; }
    }
    if (k === ' ') { e.preventDefault(); if (!$('btnTrack').disabled && !state.game.isGameOver()) setTracking(!state.tracking); }
    else if (k === 'u') undoMove();
    else if (k === 'b') rebaseline();
    else if (k === 'm') { e.preventDefault(); $('manualMove').focus(); }
    else if (k === 's') { $('drawer').classList.contains('open') ? closeDrawer() : openDrawer(); }
    else if (k === 'escape') closeDrawer();
  });
  $('btnSettings').onclick = () => openDrawer();
  $('rvFirst').onclick = () => reviewGoto(0);
  $('rvPrev').onclick = () => reviewGoto(state.review.ply - 1);
  $('rvNext').onclick = () => reviewGoto(state.review.ply + 1);
  $('rvLast').onclick = () => reviewGoto(state.review.moves.length);
  $('rvExit').onclick = exitReview;
  $('btnResultSave').onclick = () => { hideResult(); saveAndNewGame(); };
  $('btnResultClose').onclick = hideResult;
  $('btnOpenSetup').onclick = () => openDrawer('cameras');
  $('btnCloseDrawer').onclick = closeDrawer;
  $('scrim').onclick = closeDrawer;
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.onclick = () => selectTab(b.dataset.tab);

  // Installable app that also opens offline.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $('btnInstall').hidden = false; });
  window.addEventListener('appinstalled', () => { $('btnInstall').hidden = true; setStatus('Installed. Open Chess Cam Tracker from your desktop or Start menu.', 'ok'); });
  $('btnInstall').onclick = async () => { if (!installEvent) return; installEvent.prompt(); await installEvent.userChoice; installEvent = null; $('btnInstall').hidden = true; };
  listCameras(false).catch(() => {});
  if (!state.cams.length) setTimeout(() => openDrawer('cameras'), 300);
  navigator.mediaDevices?.addEventListener?.('devicechange', () => listCameras(false).catch(() => {}));
  setInterval(tick, TICK_MS);
  requestAnimationFrame(drawCams);
}

init();
