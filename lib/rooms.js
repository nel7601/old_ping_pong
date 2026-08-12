/*
 * Lógica de salas y relay, compartida entre:
 *  - server.js  (juego en local / cualquier VPS)
 *  - api/ws.js  (función WebSocket de Vercel)
 *
 * El servidor no simula el juego: solo empareja dos teléfonos con un
 * código de 4 letras y retransmite los mensajes entre ellos.
 */

// code -> { host: ws, guest: ws | null }
const rooms = new Map();

// Sin I, O, 0, 1 para evitar confusiones al dictar el código
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

function send(ws, msg) {
  if (ws && ws.readyState === OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function peerOf(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  return ws === room.host ? room.guest : room.host;
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
        rooms.set(code, { host: ws, guest: null });
        ws.roomCode = code;
        send(ws, { type: 'created', code });
        break;
      }

      case 'join': {
        const code = String(msg.code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          return send(ws, { type: 'error', reason: 'not_found' });
        }
        if (room.guest) {
          return send(ws, { type: 'error', reason: 'full' });
        }
        room.guest = ws;
        ws.roomCode = code;
        // El host saca primero; el guest espera el primer pase de bola.
        send(room.host, { type: 'start', role: 'host' });
        send(room.guest, { type: 'start', role: 'guest' });
        break;
      }

      // Todo lo demás (bola, goles, revancha...) se retransmite al rival.
      default: {
        send(peerOf(ws), msg);
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
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const peer = peerOf(ws);
    rooms.delete(ws.roomCode);
    if (peer) {
      peer.roomCode = undefined;
      send(peer, { type: 'peer_left' });
    }
  });
}
