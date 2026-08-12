/*
 * OLD PING PONG - client
 *
 * Each phone shows ITS half of the table: your paddle at the bottom and
 * the border with the rival's court at the top. The ball is simulated
 * only by the phone whose court it is in; when it leaves through the
 * top it is sent to the rival (mirrored) and enters through the top of
 * their screen.
 *
 * Court coordinates: x in [0,1], y in [0,1.6]. y=0 is the top edge
 * (border with the rival), y=1.6 is the bottom of the screen.
 */

'use strict';

// ---------------------------------------------------------------------------
// Game constants
// ---------------------------------------------------------------------------

const COURT_W = 1;
const COURT_H = 1.6;

// The screen is split into 5 fifths: the top 4 are the active area
// (where the ball lives) and the bottom fifth is the info zone.
// The dashed line marks that boundary and the paddle rests on it.
const PLAY_H = COURT_H * 4 / 5;

const PADDLE_W = 0.22;
const PADDLE_H = 0.035;
const PADDLE_Y = PLAY_H - PADDLE_H; // resting on the dashed line

const BALL_SIZE = 0.028;       // the ball is a square, like in 1972
const BALL_SPEED0 = 0.85;      // initial vertical speed (units/s)
const BALL_SPEEDUP = 1.05;     // acceleration per paddle hit
const BALL_SPEED_MAX = 2.2;
const BALL_VX_MAX = 0.9;       // max sideways speed when hit with the edge

// Match settings are chosen by the host on the CREATE screen (1-4 minutes,
// 1-3 simultaneous balls) and distributed by the server to BOTH players,
// so the two phones always agree on clock and ball count.
// (?t=SECONDS in the URL overrides the duration — handy for testing.)
const TEST_SECONDS = Number(new URLSearchParams(location.search).get('t')) || 0;
const SERVE_DELAY = 1200;      // ms before a serve
const MULTIBALL_GAP = 3000;    // ms between serves when launching several balls
const URGENT_AT = 30;          // under 30s everything turns red
const URGENT_COLOR = '#ff2222';

const CONFETTI_COLORS = ['#ff4040', '#ffd700', '#40c4ff', '#7cfc00', '#ff80ff', '#ffa500'];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  phase: 'menu',            // menu | joining | waiting | playing | over
  role: null,               // host | guest
  ws: null,

  code: null,               // room code (travels in the link)
  token: null,              // secret token to resume after a disconnect
  shareUrl: null,
  resuming: false,
  reconnectTries: 0,
  reconnectTimer: null,
  peerAway: false,          // the rival is in the background / reconnecting
  pendingServe: false,
  lastBallEvent: 0,         // watchdog: when we last saw/served/passed the ball

  paddleX: 0.5,
  balls: [],                // [{x, y, vx, vy}] — balls currently on MY side
  servesPending: 0,         // balls I still owe a serve for
  serveTimer: null,
  serveMsg: null,           // {text, until}

  config: { seconds: 240, balls: 1 },  // set by the server on 'start'/'resumed'
  optMinutes: 4,            // menu selections (host only)
  optBalls: 1,

  score: { me: 0, opp: 0 },
  myRematch: false,
  theirRematch: false,

  timeLeft: null,           // seconds remaining; null = waiting for a clock sync
  timeUpSent: false,        // host only: 'time_up' already emitted
  result: null              // {won, tie, confetti[], lastNow} end-of-match scene
};

// Survive the browser being reloaded, killed or reopened in a new tab:
// localStorage (unlike sessionStorage) outlives all of those. The server
// holds the seat for 10 minutes, so accept sessions up to 12 minutes old.
function saveSession() {
  try {
    localStorage.setItem('pong_resume',
      JSON.stringify({ code: state.code, token: state.token, ts: Date.now() }));
  } catch { /* private mode, never mind */ }
}

function clearSession() {
  try { localStorage.removeItem('pong_resume'); } catch { /* ignore */ }
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem('pong_resume'));
    if (s && s.code && s.token && Date.now() - s.ts < 12 * 60 * 1000) return s;
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const el = (id) => document.getElementById(id);
const screens = { menu: el('menu'), waiting: el('waiting'), joining: el('joining'), over: el('over') };

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name);
  }
  if (!name) {
    for (const key of Object.keys(screens)) screens[key].classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Sound (original Pong frequencies: wall 226Hz, paddle 459Hz, score 490Hz)
// ---------------------------------------------------------------------------

let audioCtx = null;

function beep(freq, duration) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch { /* no audio is fine */ }
}

const sndWall = () => beep(226, 0.04);
const sndPaddle = () => beep(459, 0.05);
const sndScore = () => beep(490, 0.25);

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
  state.ws = ws;

  ws.onopen = onOpen;
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  };
  ws.onclose = () => {
    state.ws = null;
    if (state.phase === 'menu') return;

    // First join attempt failed, no token yet: back to the menu
    if (!state.token) {
      backToMenu();
      el('menu-error').textContent = 'NO CONNECTION. TRY AGAIN';
      return;
    }

    // Any other phase: try to resume (phones drop the WebSocket when
    // the app goes to the background, e.g. while sharing the link).
    // Keep trying for as long as the server holds the seat (~10 min).
    state.reconnectTries += 1;
    if (state.reconnectTries > 240) {
      clearSession();
      backToMenu();
      el('menu-error').textContent = 'NO CONNECTION. TRY AGAIN';
      return;
    }
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(tryResume, state.reconnectTries === 1 ? 150 : 2500);
  };
}

function tryResume() {
  if (state.phase === 'menu' || !state.token || !state.code) return;
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) return; // already connected
  state.resuming = true;
  connect(() => sendMsg({ type: 'resume', code: state.code, token: state.token }));
}

function sendMsg(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'created': {
      // The rival joins by opening this link (the code travels in the URL)
      state.code = msg.code;
      state.token = msg.token;
      saveSession();
      const url = `${location.origin}${location.pathname}?j=${msg.code}`;
      state.shareUrl = url;
      el('share-url').textContent = url;
      el('copy-done').textContent = '';
      el('btn-share').classList.toggle('hidden', !navigator.share);
      state.phase = 'waiting';
      showScreen('waiting');
      break;
    }

    case 'error': {
      const wasResuming = state.resuming;
      clearSession();
      backToMenu();
      el('menu-error').textContent =
        wasResuming ? 'THE GAME WAS LOST. CREATE A NEW ONE'
        : msg.reason === 'full' ? 'THAT GAME IS ALREADY FULL'
        : 'GAME NOT FOUND. ASK FOR A NEW LINK';
      break;
    }

    case 'start':
      state.role = msg.role;
      if (msg.code) state.code = msg.code;
      if (msg.token) state.token = msg.token;
      if (msg.config) state.config = msg.config;
      saveSession();
      startMatch();
      break;

    case 'resumed':
      state.resuming = false;
      state.reconnectTries = 0;
      state.role = msg.role;
      if (msg.config) state.config = msg.config;
      saveSession();
      if (state.phase === 'over') break; // keep the game-over screen as-is
      if (msg.started) {
        // Back into the running match, wherever we came from (a brief
        // drop, a page reload, a killed browser). The server remembers
        // the score, so restore it instead of starting from zero.
        if (msg.score) {
          state.score.me = msg.score.you;
          state.score.opp = msg.score.rival;
        }
        state.phase = 'playing';
        state.lastBallEvent = performance.now();
        el('btn-rematch').classList.remove('hidden');
        showScreen(null);
        keepAwake();
        // If the match started while we were away, the queued 'start'
        // arrives right after this and (re)kicks the serve flow itself.
      } else if (state.phase === 'waiting' || state.phase === 'joining') {
        // Still waiting for the rival: rebuild the link screen
        // (the browser may have reloaded the page)
        state.shareUrl = `${location.origin}${location.pathname}?j=${state.code}`;
        el('share-url').textContent = state.shareUrl;
        el('btn-share').classList.toggle('hidden', !navigator.share);
        state.phase = 'waiting';
        showScreen('waiting');
      }
      break;

    case 'peer_away':
      state.peerAway = true;
      break;

    case 'peer_back':
      state.peerAway = false;
      state.lastBallEvent = performance.now();
      // Help a rival who just reloaded recover the match clock
      if (state.phase === 'playing' && state.timeLeft !== null) {
        sendMsg({ type: 'clock', t: state.timeLeft });
      }
      if (state.pendingServe && state.phase === 'playing') {
        state.pendingServe = false;
        scheduleNextServe(SERVE_DELAY);
      }
      break;

    case 'clock':
      if (typeof msg.t === 'number' &&
          (state.timeLeft === null || Math.abs(state.timeLeft - msg.t) > 3)) {
        state.timeLeft = msg.t;
      }
      break;

    case 'ball':
      // A ball enters through the top of my screen (already mirrored by the rival)
      state.balls.push({ x: msg.x, y: -BALL_SIZE, vx: msg.vx, vy: msg.vy });
      state.lastBallEvent = performance.now();
      // The host's clock rides along on its messages: the guest adopts it
      if (state.role === 'guest' && typeof msg.t === 'number') state.timeLeft = msg.t;
      break;

    case 'goal':
      // The rival missed: I scored. They send the score to keep us in sync.
      state.score.me = msg.scorer;
      state.score.opp = msg.conceder;
      state.lastBallEvent = performance.now();
      if (state.role === 'guest' && typeof msg.t === 'number') state.timeLeft = msg.t;
      sndScore();
      break;

    case 'time_up':
      // The host's whistle: the 4 minutes are over. Adopt its final score.
      state.score.me = msg.theirs;
      state.score.opp = msg.mine;
      endByTime();
      break;

    case 'rematch':
      state.theirRematch = true;
      tryRematch();
      break;

    case 'peer_left':
      clearSession();
      if (state.phase === 'playing' || state.phase === 'over') {
        endGame('RIVAL DISCONNECTED', 'Your rival left the game.');
        el('btn-rematch').classList.add('hidden');
      } else if (state.phase === 'waiting' || state.phase === 'joining') {
        backToMenu();
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Match flow
// ---------------------------------------------------------------------------

function startMatch() {
  state.phase = 'playing';
  state.score = { me: 0, opp: 0 };
  state.balls = [];
  state.servesPending = 0;
  clearTimeout(state.serveTimer);
  state.serveTimer = null;
  state.paddleX = 0.5;
  state.myRematch = false;
  state.theirRematch = false;
  state.pendingServe = false;
  state.lastBallEvent = performance.now();
  state.timeLeft = state.config.seconds;
  state.timeUpSent = false;
  state.result = null;
  el('over').classList.remove('result');
  saveSession();
  el('btn-rematch').classList.remove('hidden');
  showScreen(null);
  keepAwake();

  // The host launches every ball of the opening volley
  if (state.role === 'host') {
    queueServes(state.config.balls);
  } else {
    flashMessage('RIVAL SERVES');
  }
}

// Owe `count` more serves; balls launch one at a time, 3s apart
function queueServes(count) {
  state.servesPending += count;
  if (!state.serveTimer) scheduleNextServe(SERVE_DELAY);
}

function scheduleNextServe(delay) {
  flashMessage('YOU SERVE');
  clearTimeout(state.serveTimer);
  state.serveTimer = setTimeout(() => {
    state.serveTimer = null;
    if (state.phase !== 'playing' || state.servesPending <= 0) return;
    if (state.peerAway) {
      // Don't serve against a rival who isn't watching: wait for them
      state.pendingServe = true;
      return;
    }
    // The serve leaves FROM the server's paddle, straight up toward the rival
    state.balls.push({
      x: state.paddleX - BALL_SIZE / 2,
      y: PADDLE_Y - BALL_SIZE - 0.002,
      vx: (Math.random() * 0.6 - 0.3),
      vy: -BALL_SPEED0
    });
    sndPaddle();
    state.lastBallEvent = performance.now();
    state.servesPending -= 1;
    if (state.servesPending > 0) scheduleNextServe(MULTIBALL_GAP);
  }, delay);
}

function flashMessage(text) {
  state.serveMsg = { text, until: performance.now() + 1100 };
}

function concedeGoal() {
  state.score.opp += 1;
  state.lastBallEvent = performance.now();
  sndScore();
  const goal = { type: 'goal', scorer: state.score.opp, conceder: state.score.me };
  if (state.role === 'host' && state.timeLeft !== null) goal.t = state.timeLeft;
  sendMsg(goal);
  queueServes(1); // whoever misses serves that ball again
}

// Match over by clock: the result is drawn INSIDE the play area
// (confetti for the winner, a pixel sad face for the loser).
function endByTime() {
  clearTimeout(state.serveTimer);
  state.serveTimer = null;
  clearSession();
  state.phase = 'over';
  state.balls = [];
  state.servesPending = 0;
  state.timeLeft = 0;
  const tie = state.score.me === state.score.opp;
  const won = state.score.me > state.score.opp;
  state.result = {
    won,
    tie,
    lastNow: performance.now(),
    confetti: won ? Array.from({ length: 90 }, () => ({
      x: Math.random(),
      y: -Math.random() * PLAY_H,
      vx: (Math.random() - 0.5) * 0.25,
      vy: 0.25 + Math.random() * 0.55,
      size: 0.01 + Math.random() * 0.012,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      wobble: Math.random() * Math.PI * 2
    })) : null
  };
  sndScore();
  // Show only the buttons, at the bottom: the canvas is the show now
  el('over-title').textContent = '';
  el('over-detail').textContent = '';
  el('btn-rematch').textContent = 'REMATCH';
  el('over').classList.add('result');
  showScreen('over');
}

// Match over for a sad, non-sporting reason (disconnect, lost server):
// the classic full-screen message
function endGame(title, detail) {
  clearTimeout(state.serveTimer);
  state.serveTimer = null;
  clearSession();
  state.phase = 'over';
  state.balls = [];
  state.servesPending = 0;
  state.result = null;
  el('over').classList.remove('result');
  el('over-title').textContent = title;
  el('over-detail').textContent = detail;
  el('btn-rematch').textContent = 'REMATCH';
  showScreen('over');
}

function tryRematch() {
  if (state.myRematch && state.theirRematch) {
    startMatch();
  } else if (state.myRematch) {
    el('btn-rematch').textContent = 'WAITING...';
  }
}

function backToMenu() {
  clearTimeout(state.serveTimer);
  clearTimeout(state.reconnectTimer);
  clearSession();
  if (state.ws) {
    state.ws.onclose = null;
    sendMsg({ type: 'leave' }); // so the rival doesn't sit out the grace period
    state.ws.close();
    state.ws = null;
  }
  state.phase = 'menu';
  state.balls = [];
  state.servesPending = 0;
  state.serveTimer = null;
  state.code = null;
  state.token = null;
  state.resuming = false;
  state.reconnectTries = 0;
  state.peerAway = false;
  state.pendingServe = false;
  state.result = null;
  state.timeLeft = null;
  el('over').classList.remove('result');
  el('menu-error').textContent = '';
  showScreen('menu');
}

// ---------------------------------------------------------------------------
// Physics (each ball is simulated only by the phone it is currently on)
// ---------------------------------------------------------------------------

function stepBalls(dt) {
  const survivors = [];
  for (const b of state.balls) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Side walls
    if (b.x < 0) {
      b.x = -b.x;
      b.vx = Math.abs(b.vx);
      sndWall();
    } else if (b.x + BALL_SIZE > COURT_W) {
      b.x = 2 * (COURT_W - BALL_SIZE) - b.x;
      b.vx = -Math.abs(b.vx);
      sndWall();
    }

    // Paddle hit (the ball falls and crosses the paddle's top edge)
    if (b.vy > 0 && b.y + BALL_SIZE >= PADDLE_Y && b.y + BALL_SIZE <= PADDLE_Y + PADDLE_H + 0.05) {
      const paddleLeft = state.paddleX - PADDLE_W / 2;
      if (b.x + BALL_SIZE >= paddleLeft && b.x <= paddleLeft + PADDLE_W) {
        // Bounce: the impact point controls the angle, like in the original Pong
        const hit = ((b.x + BALL_SIZE / 2) - state.paddleX) / (PADDLE_W / 2);
        const speed = Math.min(Math.abs(b.vy) * BALL_SPEEDUP, BALL_SPEED_MAX);
        b.vy = -speed;
        b.vx = hit * BALL_VX_MAX;
        b.y = PADDLE_Y - BALL_SIZE;
        sndPaddle();
      }
    }

    // Off the top: over to the rival's phone (mirrored, we face each other)
    if (b.y + BALL_SIZE < 0) {
      const pass = {
        type: 'ball',
        x: COURT_W - b.x - BALL_SIZE,
        vx: -b.vx,
        vy: -b.vy
      };
      if (state.role === 'host' && state.timeLeft !== null) pass.t = state.timeLeft;
      sendMsg(pass);
      state.lastBallEvent = performance.now();
      continue; // this ball now lives on the rival's phone
    }

    // Crossed the dashed line: I missed, point for the rival
    if (b.y > PLAY_H) {
      concedeGoal();
      continue; // the lost ball is re-served by queueServes(1)
    }

    survivors.push(b);
  }
  state.balls = survivors;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

// 3x5 digits drawn with rectangles, like the 1972 scoreboards
const DIGITS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111']
};

function drawNumber(n, cx, top, px) {
  const digits = String(n).split('');
  const digitW = 3 * px, gap = px;
  const totalW = digits.length * digitW + (digits.length - 1) * gap;
  let x = cx - totalW / 2;
  for (const d of digits) {
    const rows = DIGITS[d];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (rows[r][c] === '1') {
          ctx.fillRect(Math.round(x + c * px), Math.round(top + r * px), Math.ceil(px), Math.ceil(px));
        }
      }
    }
    x += digitW + gap;
  }
}

let view = { scale: 1, ox: 0, oy: 0 };

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  const scale = Math.min(canvas.width / COURT_W, canvas.height / COURT_H);
  view = {
    scale,
    ox: (canvas.width - COURT_W * scale) / 2,
    oy: (canvas.height - COURT_H * scale) / 2
  };
}

const X = (u) => view.ox + u * view.scale;
const Y = (u) => view.oy + u * view.scale;
const S = (u) => u * view.scale;

// M:SS with the same pixel-block digits as the score, colon included
function drawTimer(seconds, cx, top, px) {
  const s = Math.max(0, Math.ceil(seconds));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  // widths in px cells: minute 3, gap 1, colon 1, gap 1, two digits 3+1+3
  const totalW = (3 + 1 + 1 + 1 + 3 + 1 + 3) * px;
  let x = cx - totalW / 2;
  drawNumber(mm, x + 1.5 * px, top, px);
  x += 4 * px;
  ctx.fillRect(Math.round(x), Math.round(top + px), Math.ceil(px), Math.ceil(px));
  ctx.fillRect(Math.round(x), Math.round(top + 3 * px), Math.ceil(px), Math.ceil(px));
  x += 2 * px;
  drawNumber(Number(ss[0]), x + 1.5 * px, top, px);
  x += 4 * px;
  drawNumber(Number(ss[1]), x + 1.5 * px, top, px);
}

// 11x11 pixel sad face for the loser, 1972 style
const SAD_FACE = [
  '...#####...',
  '..#.....#..',
  '.#.......#.',
  '#..#...#..#',
  '#..#...#..#',
  '#.........#',
  '#...###...#',
  '#..#...#..#',
  '.#.......#.',
  '..#.....#..',
  '...#####...'
];

function drawBitmap(rows, cx, top, px) {
  const w = rows[0].length * px;
  const x0 = cx - w / 2;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] === '#') {
        ctx.fillRect(Math.round(x0 + c * px), Math.round(top + r * px), Math.ceil(px), Math.ceil(px));
      }
    }
  }
}

// End-of-match scene, drawn inside the play area
function drawResult(now) {
  const res = state.result;
  const dt = Math.min((now - res.lastNow) / 1000, 0.05);
  res.lastNow = now;

  ctx.textAlign = 'center';
  if (res.tie) {
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(S(0.1))}px "Courier New", monospace`;
    ctx.fillText('DRAW', X(0.5), Y(PLAY_H / 2));
  } else if (res.won) {
    // Colored confetti raining over the winner's court
    for (const p of res.confetti) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.wobble += dt * 6;
      if (p.y > PLAY_H) {  // recycle at the top
        p.y = -0.05;
        p.x = Math.random();
      }
      if (p.y < 0) continue;
      ctx.fillStyle = p.color;
      const w = p.size * (0.6 + 0.4 * Math.abs(Math.sin(p.wobble)));
      ctx.fillRect(X(p.x), Y(p.y), S(w), S(p.size));
    }
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(S(0.11))}px "Courier New", monospace`;
    ctx.fillText('WINNER', X(0.5), Y(PLAY_H / 2));
  } else {
    ctx.fillStyle = '#fff';
    drawBitmap(SAD_FACE, X(0.5), Y(0.28), S(0.032));
    ctx.font = `bold ${Math.round(S(0.09))}px "Courier New", monospace`;
    ctx.fillText('YOU LOST', X(0.5), Y(0.95));
  }
}

function render(now) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const active = state.phase === 'playing';
  const ended = state.phase === 'over' && state.result;
  if (!active && !ended) return;

  // Under 30 seconds everything turns red: line, paddle, ball, score...
  const urgent = active && state.timeLeft !== null && state.timeLeft < URGENT_AT;
  const color = urgent ? URGENT_COLOR : '#fff';
  ctx.fillStyle = color;

  // Side walls of the active area (the top 4/5)
  ctx.fillRect(X(0) - S(0.008), Y(0), S(0.008), S(PLAY_H));
  ctx.fillRect(X(COURT_W), Y(0), S(0.008), S(PLAY_H));

  // Dashed line: boundary between the play area and the info zone
  const dashW = S(0.03);
  for (let x = 0; x < COURT_W; x += 0.06) {
    ctx.fillRect(X(x), Y(PLAY_H), dashW, S(0.008));
  }

  if (active) {
    // Paddle, resting on the line
    ctx.fillRect(X(state.paddleX - PADDLE_W / 2), Y(PADDLE_Y), S(PADDLE_W), S(PADDLE_H));

    // Balls (off the top they simply fly into the rival's screen)
    for (const b of state.balls) {
      ctx.fillRect(X(b.x), Y(b.y), S(BALL_SIZE), S(BALL_SIZE));
    }
  }

  // ---- Info zone: the bottom fifth, below the line ----

  // Score in the corners, clock in the middle, well apart from each other
  ctx.font = `${Math.round(S(0.028))}px "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.globalAlpha = 0.7;
  ctx.fillText('YOU', X(0.12), Y(PLAY_H + 0.06));
  ctx.fillText('TIME', X(0.5), Y(PLAY_H + 0.06));
  ctx.fillText('RIVAL', X(0.88), Y(PLAY_H + 0.06));
  ctx.globalAlpha = 1;
  drawNumber(state.score.me, X(0.12), Y(PLAY_H + 0.09), S(0.02));
  drawNumber(state.score.opp, X(0.88), Y(PLAY_H + 0.09), S(0.02));
  if (state.timeLeft !== null) {
    drawTimer(state.timeLeft, X(0.5), Y(PLAY_H + 0.09), S(0.02));
  }

  if (ended) {
    drawResult(now);
    return;
  }

  // Match status (blinks like the old arcades)
  const blinkOn = Math.floor(now / 500) % 2 === 0;
  const statusY = Y(PLAY_H + 0.27);
  if (state.serveMsg && now > state.serveMsg.until) state.serveMsg = null;
  ctx.font = `${Math.round(S(0.033))}px "Courier New", monospace`;
  if (state.resuming || !state.ws) {
    if (blinkOn) ctx.fillText('RECONNECTING...', X(0.5), statusY);
  } else if (state.peerAway) {
    if (blinkOn) ctx.fillText('HOLD ON: YOUR RIVAL IS COMING BACK', X(0.5), statusY);
  } else if (state.serveMsg) {
    ctx.font = `bold ${Math.round(S(0.04))}px "Courier New", monospace`;
    ctx.fillText(state.serveMsg.text, X(0.5), statusY);
  } else if (state.balls.length === 0 && state.servesPending === 0) {
    const label = state.config.balls > 1 ? '· BALLS ON RIVAL SIDE ·' : '· BALL ON RIVAL SIDE ·';
    if (blinkOn) ctx.fillText(label, X(0.5), statusY);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let lastTime = 0;

function loop(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  // The game pauses while the rival is in the background or reconnecting
  const running = state.phase === 'playing' && !state.peerAway && !state.resuming;
  if (running) stepBalls(dt);

  // Match clock: counts down only while both players are present.
  // The host is the referee: it blows the final whistle for both.
  if (running && state.timeLeft !== null) {
    state.timeLeft = Math.max(0, state.timeLeft - dt);
    if (state.timeLeft <= 0 && state.role === 'host' && !state.timeUpSent) {
      state.timeUpSent = true;
      sendMsg({ type: 'time_up', mine: state.score.me, theirs: state.score.opp });
      endByTime();
    }
  }

  // Ball watchdog: if every ball has been "on the rival side" suspiciously
  // long with both players present, they got lost in a disconnect (e.g.
  // one was in the rival's RAM when their browser reloaded). The host
  // serves a fresh one so the match never stalls forever.
  if (state.phase === 'playing' && state.balls.length === 0 && !state.peerAway &&
      !state.resuming && !state.pendingServe && state.servesPending === 0 &&
      state.ws && now - state.lastBallEvent > 8000) {
    state.lastBallEvent = now;
    if (state.role === 'host') queueServes(1);
  }

  render(now);
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Touch controls
// ---------------------------------------------------------------------------

function onPointer(ev) {
  ev.preventDefault();
  // Unlock audio on the first gesture (needed when arriving via link)
  if (!audioCtx) beep(0.01, 0.01);
  else if (audioCtx.state === 'suspended') audioCtx.resume();
  const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
  const dpr = window.devicePixelRatio || 1;
  const u = (clientX * dpr - view.ox) / view.scale;
  const half = PADDLE_W / 2;
  state.paddleX = Math.max(half, Math.min(COURT_W - half, u));
}

canvas.addEventListener('touchstart', onPointer, { passive: false });
canvas.addEventListener('touchmove', onPointer, { passive: false });
canvas.addEventListener('mousedown', onPointer);
canvas.addEventListener('mousemove', (ev) => { if (ev.buttons) onPointer(ev); });

// Keep the screen on during the match (when the browser allows it)
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
  } catch { /* optional */ }
}

// ---------------------------------------------------------------------------
// UI buttons
// ---------------------------------------------------------------------------

// Match option selectors: time (1-4 min) and simultaneous balls (1-3)
for (const btn of document.querySelectorAll('.opt-btn[data-min]')) {
  btn.addEventListener('click', () => {
    state.optMinutes = Number(btn.dataset.min);
    for (const b of document.querySelectorAll('.opt-btn[data-min]')) {
      b.classList.toggle('sel', b === btn);
    }
  });
}
for (const btn of document.querySelectorAll('.opt-btn[data-balls]')) {
  btn.addEventListener('click', () => {
    state.optBalls = Number(btn.dataset.balls);
    for (const b of document.querySelectorAll('.opt-btn[data-balls]')) {
      b.classList.toggle('sel', b === btn);
    }
  });
}

el('btn-create').addEventListener('click', () => {
  beep(459, 0.03); // unlocks audio with the user's first gesture
  el('menu-error').textContent = '';
  connect(() => sendMsg({
    type: 'create',
    seconds: TEST_SECONDS || state.optMinutes * 60,
    balls: state.optBalls
  }));
});

el('btn-share').addEventListener('click', async () => {
  try {
    await navigator.share({ title: 'PONG', text: 'Play Pong with me:', url: state.shareUrl });
  } catch { /* the user closed the share sheet */ }
});

el('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.shareUrl);
    el('copy-done').textContent = 'COPIED';
  } catch {
    el('copy-done').textContent = 'COPY FAILED, DO IT BY HAND';
  }
  setTimeout(() => { el('copy-done').textContent = ''; }, 2000);
});

el('btn-cancel').addEventListener('click', backToMenu);
el('btn-exit').addEventListener('click', backToMenu);

el('btn-rematch').addEventListener('click', () => {
  state.myRematch = true;
  sendMsg({ type: 'rematch' });
  tryRematch();
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

window.addEventListener('resize', resize);
resize();

// If the page was opened with a game link (?j=CODE), join right away
const joinCode = new URLSearchParams(location.search).get('j');
const savedSession = loadSession();
if (joinCode) {
  history.replaceState(null, '', location.pathname); // don't re-join on reload
  clearSession();
  state.phase = 'joining';
  showScreen('joining');
  connect(() => sendMsg({ type: 'join', code: joinCode }));
} else if (savedSession) {
  // The browser reloaded the page (e.g. coming back from WhatsApp):
  // recover the game in progress
  state.code = savedSession.code;
  state.token = savedSession.token;
  state.phase = 'joining';
  showScreen('joining');
  state.resuming = true;
  connect(() => sendMsg({ type: 'resume', code: state.code, token: state.token }));
}

// On returning to the foreground, reconnect without waiting for the next retry
function reconnectIfNeeded() {
  if (state.token && state.phase !== 'menu' &&
      (!state.ws || state.ws.readyState > WebSocket.OPEN)) {
    clearTimeout(state.reconnectTimer);
    tryResume();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reconnectIfNeeded();
});

// Some mobile browsers restore the page from the back/forward cache
// instead of firing visibilitychange — cover that path too
window.addEventListener('pageshow', reconnectIfNeeded);

// Keep the saved session fresh while a game or a waiting room is active,
// so even a long match can be recovered after the browser is killed
setInterval(() => {
  if (state.token && (state.phase === 'playing' || state.phase === 'waiting')) {
    saveSession();
  }
}, 20000);

requestAnimationFrame((t) => { lastTime = t; requestAnimationFrame(loop); });

// Exposed for automated tests; not part of the game logic
window.__pong = state;
