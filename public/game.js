/*
 * OLD PING PONG - cliente
 *
 * Cada teléfono muestra SU mitad de la mesa: tu paleta abajo y la
 * frontera con el campo rival arriba. La bola solo la simula el
 * teléfono en cuyo campo está; cuando sale por arriba, se envía al
 * rival (espejada) y entra por la parte superior de su pantalla.
 *
 * Coordenadas del campo: x en [0,1], y en [0,1.6]. y=0 es la red
 * (frontera con el rival), y=1.6 es el fondo detrás de tu paleta.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constantes del juego
// ---------------------------------------------------------------------------

const COURT_W = 1;
const COURT_H = 1.6;

const PADDLE_W = 0.22;
const PADDLE_H = 0.035;
const PADDLE_Y = 1.5;          // borde superior de la paleta

const BALL_SIZE = 0.028;       // la bola es un cuadrado, como en 1972
const BALL_SPEED0 = 0.85;      // velocidad vertical inicial (unidades/s)
const BALL_SPEEDUP = 1.05;     // aceleración por golpe de paleta
const BALL_SPEED_MAX = 2.2;
const BALL_VX_MAX = 0.9;       // máxima velocidad lateral al golpear con el borde

const WIN_SCORE = 11;

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

const state = {
  phase: 'menu',            // menu | joining | waiting | playing | over
  role: null,               // host | guest
  ws: null,

  code: null,               // código de la sala (viaja en el enlace)
  token: null,              // token secreto para reanudar tras una desconexión
  shareUrl: null,
  resuming: false,
  reconnectTries: 0,
  reconnectTimer: null,
  peerAway: false,          // el rival está en segundo plano / reconectando
  pendingServe: false,

  paddleX: 0.5,
  ball: null,               // {x, y, vx, vy} o null si está en campo rival
  serveTimer: null,
  serveMsg: null,           // {text, until}

  score: { me: 0, opp: 0 },
  myRematch: false,
  theirRematch: false
};

// Para sobrevivir a que el navegador recargue la página al volver de otra app
function saveSession() {
  try {
    sessionStorage.setItem('pong_resume',
      JSON.stringify({ code: state.code, token: state.token, ts: Date.now() }));
  } catch { /* modo privado, da igual */ }
}

function clearSession() {
  try { sessionStorage.removeItem('pong_resume'); } catch { /* ignorar */ }
}

function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem('pong_resume'));
    if (s && s.code && s.token && Date.now() - s.ts < 3 * 60 * 1000) return s;
  } catch { /* ignorar */ }
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
// Sonido (frecuencias del Pong original: pared 226Hz, paleta 459Hz, punto 490Hz)
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
  } catch { /* sin audio no pasa nada */ }
}

const sndWall = () => beep(226, 0.04);
const sndPaddle = () => beep(459, 0.05);
const sndScore = () => beep(490, 0.25);

// ---------------------------------------------------------------------------
// Red
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

    // Primer intento de unirse fallido, sin token aún: volver al menú
    if (!state.token) {
      backToMenu();
      el('menu-error').textContent = 'SIN CONEXION. INTENTALO DE NUEVO';
      return;
    }

    // En cualquier otra fase: intentar reanudar (el móvil corta el
    // WebSocket al pasar a segundo plano, p. ej. al compartir el enlace)
    state.reconnectTries += 1;
    if (state.reconnectTries > 50) {
      clearSession();
      backToMenu();
      el('menu-error').textContent = 'SIN CONEXION. INTENTALO DE NUEVO';
      return;
    }
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(tryResume, state.reconnectTries === 1 ? 150 : 2500);
  };
}

function tryResume() {
  if (state.phase === 'menu' || !state.token || !state.code) return;
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) return; // ya hay conexión
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
      // El rival se une abriendo este enlace (el código viaja en la URL)
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
        wasResuming ? 'LA PARTIDA SE PERDIO. CREA OTRA'
        : msg.reason === 'full' ? 'ESA PARTIDA YA ESTA LLENA'
        : 'PARTIDA NO ENCONTRADA. PIDE UN ENLACE NUEVO';
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
      if (!msg.started && (state.phase === 'waiting' || state.phase === 'joining')) {
        // Seguimos esperando al rival: reconstruir la pantalla del enlace
        // (puede que el navegador haya recargado la página)
        state.shareUrl = `${location.origin}${location.pathname}?j=${state.code}`;
        el('share-url').textContent = state.shareUrl;
        el('btn-share').classList.toggle('hidden', !navigator.share);
        state.phase = 'waiting';
        showScreen('waiting');
      } else if (msg.started && state.phase === 'playing') {
        showScreen(null);
      }
      // Si la partida empezó mientras estábamos fuera, el 'start' encolado
      // llega justo después y arranca el juego solo.
      break;

    case 'peer_away':
      state.peerAway = true;
      break;

    case 'peer_back':
      state.peerAway = false;
      if (state.pendingServe && state.phase === 'playing') {
        state.pendingServe = false;
        scheduleServe();
      }
      break;

    case 'ball':
      // La bola entra por arriba de mi pantalla (el rival ya la envió espejada)
      state.ball = { x: msg.x, y: -BALL_SIZE, vx: msg.vx, vy: msg.vy };
      break;

    case 'goal':
      // El rival falló: yo anoté. Él manda el marcador para mantenernos en sincronía.
      state.score.me = msg.scorer;
      state.score.opp = msg.conceder;
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
        endGame('RIVAL DESCONECTADO', 'Tu rival abandono la partida.');
        el('btn-rematch').classList.add('hidden');
      } else if (state.phase === 'waiting' || state.phase === 'joining') {
        backToMenu();
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Flujo de partida
// ---------------------------------------------------------------------------

function startMatch() {
  state.phase = 'playing';
  state.score = { me: 0, opp: 0 };
  state.ball = null;
  state.paddleX = 0.5;
  state.myRematch = false;
  state.theirRematch = false;
  state.pendingServe = false;
  saveSession();
  el('btn-rematch').classList.remove('hidden');
  showScreen(null);
  keepAwake();

  // El host hace el primer saque
  if (state.role === 'host') {
    scheduleServe();
  } else {
    flashMessage('SACA EL RIVAL');
  }
}

function scheduleServe() {
  flashMessage('TU SACAS');
  clearTimeout(state.serveTimer);
  state.serveTimer = setTimeout(() => {
    if (state.phase !== 'playing') return;
    if (state.peerAway) {
      // No sacar contra un rival que no está mirando: esperar a que vuelva
      state.pendingServe = true;
      return;
    }
    // El saque sale desde tu campo hacia el rival, como en el tenis de mesa real
    const angle = (Math.random() * 0.6 - 0.3); // vx aleatorio suave
    state.ball = {
      x: 0.3 + Math.random() * 0.4,
      y: 1.15,
      vx: angle,
      vy: -BALL_SPEED0
    };
  }, 1200);
}

function flashMessage(text) {
  state.serveMsg = { text, until: performance.now() + 1100 };
}

function concedeGoal() {
  state.ball = null;
  state.score.opp += 1;
  sndScore();
  sendMsg({ type: 'goal', scorer: state.score.opp, conceder: state.score.me });
  if (!checkWin()) {
    scheduleServe(); // el que falla vuelve a sacar
  }
}

function checkWin() {
  if (state.score.me >= WIN_SCORE) {
    endGame('GANASTE', `${state.score.me} - ${state.score.opp}`);
    return true;
  }
  if (state.score.opp >= WIN_SCORE) {
    endGame('PERDISTE', `${state.score.opp} - ${state.score.me}`);
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
  el('btn-rematch').textContent = 'REVANCHA';
  showScreen('over');
}

function tryRematch() {
  if (state.myRematch && state.theirRematch) {
    startMatch();
  } else if (state.myRematch) {
    el('btn-rematch').textContent = 'ESPERANDO...';
  }
}

function backToMenu() {
  clearTimeout(state.serveTimer);
  clearTimeout(state.reconnectTimer);
  clearSession();
  if (state.ws) {
    state.ws.onclose = null;
    sendMsg({ type: 'leave' }); // que el rival no espere el periodo de gracia
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
// Física (solo corre cuando la bola está en mi campo)
// ---------------------------------------------------------------------------

function stepBall(dt) {
  const b = state.ball;
  if (!b) return;

  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // Paredes laterales
  if (b.x < 0) {
    b.x = -b.x;
    b.vx = Math.abs(b.vx);
    sndWall();
  } else if (b.x + BALL_SIZE > COURT_W) {
    b.x = 2 * (COURT_W - BALL_SIZE) - b.x;
    b.vx = -Math.abs(b.vx);
    sndWall();
  }

  // Golpe de paleta (la bola baja y cruza el borde superior de la paleta)
  if (b.vy > 0 && b.y + BALL_SIZE >= PADDLE_Y && b.y + BALL_SIZE <= PADDLE_Y + PADDLE_H + 0.05) {
    const paddleLeft = state.paddleX - PADDLE_W / 2;
    if (b.x + BALL_SIZE >= paddleLeft && b.x <= paddleLeft + PADDLE_W) {
      // Rebote: el punto de impacto controla el ángulo, como en el Pong original
      const hit = ((b.x + BALL_SIZE / 2) - state.paddleX) / (PADDLE_W / 2);
      const speed = Math.min(Math.abs(b.vy) * BALL_SPEEDUP, BALL_SPEED_MAX);
      b.vy = -speed;
      b.vx = hit * BALL_VX_MAX;
      b.y = PADDLE_Y - BALL_SIZE;
      sndPaddle();
    }
  }

  // Sale por arriba: pasa al teléfono del rival (espejada, porque estamos frente a frente)
  if (b.y + BALL_SIZE < 0) {
    sendMsg({
      type: 'ball',
      x: COURT_W - b.x - BALL_SIZE,
      vx: -b.vx,
      vy: -b.vy
    });
    state.ball = null;
    return;
  }

  // Sale por abajo: fallé, punto para el rival
  if (b.y > COURT_H) {
    concedeGoal();
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

// Dígitos 3x5 dibujados con rectángulos, como los marcadores de 1972
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

  // Red: línea discontinua arriba, la frontera con el teléfono rival
  const dashW = S(0.03);
  for (let x = 0; x < COURT_W; x += 0.06) {
    ctx.fillRect(X(x), Y(0), dashW, S(0.008));
  }

  // Paredes laterales
  ctx.fillRect(X(0) - S(0.008), Y(0), S(0.008), S(COURT_H));
  ctx.fillRect(X(COURT_W), Y(0), S(0.008), S(COURT_H));

  // Marcador: rival arriba, yo abajo
  ctx.globalAlpha = 0.85;
  drawNumber(state.score.opp, X(0.5), Y(0.12), S(0.022));
  drawNumber(state.score.me, X(0.5), Y(COURT_H - 0.26), S(0.022));
  ctx.globalAlpha = 1;

  // Paleta
  ctx.fillRect(X(state.paddleX - PADDLE_W / 2), Y(PADDLE_Y), S(PADDLE_W), S(PADDLE_H));

  // Bola
  if (state.ball) {
    ctx.fillRect(X(state.ball.x), Y(state.ball.y), S(BALL_SIZE), S(BALL_SIZE));
  }

  // Avisos de estado (parpadean como en las recreativas)
  const blinkOn = Math.floor(now / 500) % 2 === 0;
  ctx.font = `${Math.round(S(0.035))}px "Courier New", monospace`;
  ctx.textAlign = 'center';
  if (state.resuming || !state.ws) {
    if (blinkOn) ctx.fillText('RECONECTANDO...', X(0.5), Y(0.35));
  } else if (state.peerAway) {
    if (blinkOn) ctx.fillText('ESPERA: TU RIVAL VUELVE ENSEGUIDA', X(0.5), Y(0.35));
  } else if (!state.ball && !state.serveMsg) {
    if (blinkOn) ctx.fillText('· BOLA EN CAMPO RIVAL ·', X(0.5), Y(0.35));
  }

  // Mensaje de saque
  if (state.serveMsg) {
    if (now > state.serveMsg.until) {
      state.serveMsg = null;
    } else {
      ctx.font = `bold ${Math.round(S(0.05))}px "Courier New", monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(state.serveMsg.text, X(0.5), Y(0.75));
    }
  }
}

// ---------------------------------------------------------------------------
// Bucle principal
// ---------------------------------------------------------------------------

let lastTime = 0;

function loop(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  // El juego se pausa mientras el rival está en segundo plano o reconectando
  if (state.phase === 'playing' && !state.peerAway && !state.resuming) stepBall(dt);
  render(now);
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Controles táctiles
// ---------------------------------------------------------------------------

function onPointer(ev) {
  ev.preventDefault();
  // Desbloquear el audio con el primer gesto (necesario si se entró por enlace)
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

// Mantener la pantalla encendida durante la partida (si el navegador lo permite)
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
  } catch { /* opcional */ }
}

// ---------------------------------------------------------------------------
// Botones de la interfaz
// ---------------------------------------------------------------------------

el('btn-create').addEventListener('click', () => {
  beep(459, 0.03); // desbloquea el audio con el primer gesto del usuario
  el('menu-error').textContent = '';
  connect(() => sendMsg({ type: 'create' }));
});

el('btn-share').addEventListener('click', async () => {
  try {
    await navigator.share({ title: 'PONG', text: 'Juega Pong conmigo:', url: state.shareUrl });
  } catch { /* el usuario cerró el menú de compartir */ }
});

el('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.shareUrl);
    el('copy-done').textContent = 'COPIADO';
  } catch {
    el('copy-done').textContent = 'NO SE PUDO COPIAR, HAZLO A MANO';
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
// Arranque
// ---------------------------------------------------------------------------

window.addEventListener('resize', resize);
resize();

// Si la página se abrió con un enlace de partida (?j=CODIGO), unirse directamente
const joinCode = new URLSearchParams(location.search).get('j');
const savedSession = loadSession();
if (joinCode) {
  history.replaceState(null, '', location.pathname); // no re-unirse al recargar
  clearSession();
  state.phase = 'joining';
  showScreen('joining');
  connect(() => sendMsg({ type: 'join', code: joinCode }));
} else if (savedSession) {
  // El navegador recargó la página (p. ej. al volver de WhatsApp):
  // recuperar la partida en curso
  state.code = savedSession.code;
  state.token = savedSession.token;
  state.phase = 'joining';
  showScreen('joining');
  state.resuming = true;
  connect(() => sendMsg({ type: 'resume', code: state.code, token: state.token }));
}

// Al volver a primer plano, reconectar sin esperar al siguiente reintento
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.token && state.phase !== 'menu' &&
      (!state.ws || state.ws.readyState > WebSocket.OPEN)) {
    clearTimeout(state.reconnectTimer);
    tryResume();
  }
});

requestAnimationFrame((t) => { lastTime = t; requestAnimationFrame(loop); });
