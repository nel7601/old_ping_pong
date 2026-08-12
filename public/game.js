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

const WIN_SCORE = 11;

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
  ball: null,               // {x, y, vx, vy} or null while on the rival's side
  serveTimer: null,
  serveMsg: null,           // {text, until}

  score: { me: 0, opp: 0 },
  myRematch: false,
  theirRematch: false
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
      saveSession();
      startMatch();
      break;

    case 'resumed':
      state.resuming = false;
      state.reconnectTries = 0;
      state.role = msg.role;
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
      if (state.pendingServe && state.phase === 'playing') {
        state.pendingServe = false;
        scheduleServe();
      }
      break;

    case 'ball':
      // The ball enters through the top of my screen (already mirrored by the rival)
      state.ball = { x: msg.x, y: -BALL_SIZE, vx: msg.vx, vy: msg.vy };
      state.lastBallEvent = performance.now();
      break;

    case 'goal':
      // The rival missed: I scored. They send the score to keep us in sync.
      state.score.me = msg.scorer;
      state.score.opp = msg.conceder;
      state.lastBallEvent = performance.now();
      sndScore();
      checkWin();
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
  state.ball = null;
  state.paddleX = 0.5;
  state.myRematch = false;
  state.theirRematch = false;
  state.pendingServe = false;
  state.lastBallEvent = performance.now();
  saveSession();
  el('btn-rematch').classList.remove('hidden');
  showScreen(null);
  keepAwake();

  // The host serves first
  if (state.role === 'host') {
    scheduleServe();
  } else {
    flashMessage('RIVAL SERVES');
  }
}

function scheduleServe() {
  flashMessage('YOU SERVE');
  clearTimeout(state.serveTimer);
  state.serveTimer = setTimeout(() => {
    if (state.phase !== 'playing') return;
    if (state.peerAway) {
      // Don't serve against a rival who isn't watching: wait for them
      state.pendingServe = true;
      return;
    }
    // The serve goes from your court toward the rival, like real table tennis
    const angle = (Math.random() * 0.6 - 0.3); // gentle random vx
    state.ball = {
      x: 0.3 + Math.random() * 0.4,
      y: PLAY_H - 0.25,
      vx: angle,
      vy: -BALL_SPEED0
    };
    state.lastBallEvent = performance.now();
  }, 1200);
}

function flashMessage(text) {
  state.serveMsg = { text, until: performance.now() + 1100 };
}

function concedeGoal() {
  state.ball = null;
  state.score.opp += 1;
  state.lastBallEvent = performance.now();
  sndScore();
  sendMsg({ type: 'goal', scorer: state.score.opp, conceder: state.score.me });
  if (!checkWin()) {
    scheduleServe(); // whoever misses serves again
  }
}

function checkWin() {
  if (state.score.me >= WIN_SCORE) {
    endGame('YOU WIN', `${state.score.me} - ${state.score.opp}`);
    return true;
  }
  if (state.score.opp >= WIN_SCORE) {
    endGame('YOU LOSE', `${state.score.opp} - ${state.score.me}`);
    return true;
  }
  return false;
}

function endGame(title, detail) {
  clearTimeout(state.serveTimer);
  clearSession();
  state.phase = 'over';
  state.ball = null;
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
  state.ball = null;
  state.code = null;
  state.token = null;
  state.resuming = false;
  state.reconnectTries = 0;
  state.peerAway = false;
  state.pendingServe = false;
  el('menu-error').textContent = '';
  showScreen('menu');
}

// ---------------------------------------------------------------------------
// Physics (only runs while the ball is on my side)
// ---------------------------------------------------------------------------

function stepBall(dt) {
  const b = state.ball;
  if (!b) return;

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
    sendMsg({
      type: 'ball',
      x: COURT_W - b.x - BALL_SIZE,
      vx: -b.vx,
      vy: -b.vy
    });
    state.ball = null;
    state.lastBallEvent = performance.now();
    return;
  }

  // Crossed the dashed line: I missed, point for the rival
  if (b.y > PLAY_H) {
    concedeGoal();
  }
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

function render(now) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (state.phase !== 'playing') return;

  ctx.fillStyle = '#fff';

  // Side walls of the active area (the top 4/5)
  ctx.fillRect(X(0) - S(0.008), Y(0), S(0.008), S(PLAY_H));
  ctx.fillRect(X(COURT_W), Y(0), S(0.008), S(PLAY_H));

  // Dashed line: boundary between the play area and the info zone
  const dashW = S(0.03);
  for (let x = 0; x < COURT_W; x += 0.06) {
    ctx.fillRect(X(x), Y(PLAY_H), dashW, S(0.008));
  }

  // Paddle, resting on the line
  ctx.fillRect(X(state.paddleX - PADDLE_W / 2), Y(PADDLE_Y), S(PADDLE_W), S(PADDLE_H));

  // Ball (off the top it simply flies into the rival's screen)
  if (state.ball) {
    ctx.fillRect(X(state.ball.x), Y(state.ball.y), S(BALL_SIZE), S(BALL_SIZE));
  }

  // ---- Info zone: the bottom fifth, below the line ----

  // Score: YOU on the left, RIVAL on the right
  ctx.font = `${Math.round(S(0.028))}px "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.globalAlpha = 0.7;
  ctx.fillText('YOU', X(0.28), Y(PLAY_H + 0.06));
  ctx.fillText('RIVAL', X(0.72), Y(PLAY_H + 0.06));
  ctx.globalAlpha = 1;
  drawNumber(state.score.me, X(0.28), Y(PLAY_H + 0.09), S(0.02));
  drawNumber(state.score.opp, X(0.72), Y(PLAY_H + 0.09), S(0.02));

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
  } else if (!state.ball) {
    if (blinkOn) ctx.fillText('· BALL ON RIVAL SIDE ·', X(0.5), statusY);
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
  if (state.phase === 'playing' && !state.peerAway && !state.resuming) stepBall(dt);

  // Ball watchdog: if the ball has been "on the rival side" suspiciously
  // long with both players present, it got lost in a disconnect (e.g. it
  // was in the rival's RAM when their browser reloaded). The host serves
  // a fresh one so the match never stalls forever.
  if (state.phase === 'playing' && !state.ball && !state.peerAway && !state.resuming &&
      !state.pendingServe && state.ws && now - state.lastBallEvent > 8000) {
    state.lastBallEvent = now;
    if (state.role === 'host') scheduleServe();
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

el('btn-create').addEventListener('click', () => {
  beep(459, 0.03); // unlocks audio with the user's first gesture
  el('menu-error').textContent = '';
  connect(() => sendMsg({ type: 'create' }));
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
