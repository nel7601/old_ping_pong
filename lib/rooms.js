/*
 * Lógica de salas y relay, compartida entre:
 *  - server.js  (juego en local / cualquier VPS)
 *  - api/ws.js  (función WebSocket de Vercel)
 *
 * El servidor no simula el juego: empareja dos teléfonos y retransmite
 * mensajes. Los móviles cortan el WebSocket al pasar la app a segundo
 * plano (por ejemplo, al compartir el enlace por WhatsApp), así que cada
 * jugador recibe un token secreto y puede REANUDAR su sitio durante un
 * periodo de gracia; mientras tanto sus mensajes pendientes se encolan.
 */

import { randomBytes } from 'node:crypto';

// code -> room
const rooms = new Map();

// Tiempo que se guarda el sitio de un jugador desconectado
const GRACE_MS = Number(process.env.PONG_GRACE_MS) || 120000;

// Sin I, O, 0, 1 para que la URL no dé lugar a confusión
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const OPEN = 1; // WebSocket.OPEN

function newCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function newSlot(ws) {
  return {
    ws,
    token: randomBytes(12).toString('hex'),
    timer: null,   // temporizador de gracia mientras está desconectado
    queue: []      // mensajes pendientes de entregar cuando vuelva
  };
}

function slotSend(slot, msg) {
  if (!slot) return;
  const data = JSON.stringify(msg);
  if (slot.ws && slot.ws.readyState === OPEN) {
    slot.ws.send(data);
  } else {
    slot.queue.push(data);
    if (slot.queue.length > 200) slot.queue.shift();
  }
}

function peerSlotOf(room, role) {
  return role === 'host' ? room.guest : room.host;
}

function destroyRoom(room, reason) {
  if (rooms.get(room.code) !== room) return;
  rooms.delete(room.code);
  for (const slot of [room.host, room.guest]) {
    if (!slot) continue;
    clearTimeout(slot.timer);
    if (slot.ws && slot.ws.readyState === OPEN) {
      try { slot.ws.send(JSON.stringify({ type: reason })); } catch { /* ignorar */ }
    }
  }
}

function attach(ws, room, role) {
  ws.pongRoom = room;
  ws.pongRole = role;
}

/**
 * Conecta un nuevo cliente al sistema de salas. Compatible con cualquier
 * objeto tipo `ws` (la librería `ws` en local, o el socket que entrega
 * experimental_upgradeWebSocket en Vercel).
 */
export function handleConnection(ws) {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'create': {
        const code = newCode();
        const room = { code, started: false, host: newSlot(ws), guest: null };
        rooms.set(code, room);
        attach(ws, room, 'host');
        slotSend(room.host, { type: 'created', code, token: room.host.token });
        break;
      }

      case 'join': {
        const code = String(msg.code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          return slotSend({ ws, queue: [] }, { type: 'error', reason: 'not_found' });
        }
        if (room.guest) {
          return slotSend({ ws, queue: [] }, { type: 'error', reason: 'full' });
        }
        room.guest = newSlot(ws);
        room.started = true;
        attach(ws, room, 'guest');
        // El host saca primero; si está ausente (compartiendo el enlace),
        // recibirá el 'start' encolado al reanudar.
        slotSend(room.host, { type: 'start', role: 'host', code, token: room.host.token });
        slotSend(room.guest, { type: 'start', role: 'guest', code, token: room.guest.token });
        if (!(room.host.ws && room.host.ws.readyState === OPEN)) {
          slotSend(room.guest, { type: 'peer_away' });
        }
        break;
      }

      case 'resume': {
        const code = String(msg.code || '').trim().toUpperCase();
        const room = rooms.get(code);
        const role =
          room && room.host.token === msg.token ? 'host'
          : room && room.guest && room.guest.token === msg.token ? 'guest'
          : null;
        if (!role) {
          return slotSend({ ws, queue: [] }, { type: 'error', reason: 'not_found' });
        }
        const slot = role === 'host' ? room.host : room.guest;
        // Si quedaba una conexión zombi, la cerramos
        if (slot.ws && slot.ws !== ws) {
          try { slot.ws.close(); } catch { /* ignorar */ }
        }
        clearTimeout(slot.timer);
        slot.timer = null;
        slot.ws = ws;
        attach(ws, room, role);
        slotSend(slot, { type: 'resumed', role, started: room.started });
        // Entregar lo que pasó mientras estaba fuera, en orden
        const pending = slot.queue.splice(0);
        for (const data of pending) {
          if (ws.readyState === OPEN) ws.send(data);
        }
        const peer = peerSlotOf(room, role);
        if (peer) slotSend(peer, { type: 'peer_back' });
        break;
      }

      // Salida voluntaria: destruir la sala ya, sin periodo de gracia
      case 'leave': {
        const room = ws.pongRoom;
        if (room) destroyRoom(room, 'peer_left');
        break;
      }

      // Todo lo demás (bola, goles, revancha...) se retransmite al rival.
      default: {
        const room = ws.pongRoom;
        if (room && rooms.get(room.code) === room) {
          slotSend(peerSlotOf(room, ws.pongRole), msg);
        }
      }
    }
  });

  // Latido para detectar teléfonos que perdieron la señal
  const heartbeat = setInterval(() => {
    try {
      if (ws.readyState === OPEN && typeof ws.ping === 'function') ws.ping();
    } catch { /* ignorar */ }
  }, 30000);

  ws.on('close', () => {
    clearInterval(heartbeat);
    const room = ws.pongRoom;
    if (!room || rooms.get(room.code) !== room) return;
    const slot = ws.pongRole === 'host' ? room.host : room.guest;
    if (!slot || slot.ws !== ws) return; // ya reanudó con otra conexión

    // No borrar la sala: darle un periodo de gracia para volver
    slot.ws = null;
    const peer = peerSlotOf(room, ws.pongRole);
    if (peer) slotSend(peer, { type: 'peer_away' });
    slot.timer = setTimeout(() => {
      destroyRoom(room, 'peer_left');
    }, GRACE_MS);
  });
}
