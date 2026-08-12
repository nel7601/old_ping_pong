/*
 * Room and relay logic, shared between:
 *  - server.js  (local play / any VPS)
 *  - api/ws.js  (Vercel WebSocket function)
 *
 * The server does not simulate the game: it pairs two phones and relays
 * messages. Phones drop the WebSocket when the app goes to the background
 * (for example while sharing the link on WhatsApp), so each player gets
 * a secret token and can RESUME their seat during a grace period; in the
 * meantime their pending messages are queued.
 */

import { randomBytes } from 'node:crypto';

// code -> room
const rooms = new Map();

// How long a disconnected player's seat is kept
const GRACE_MS = Number(process.env.PONG_GRACE_MS) || 600000;

// No I, O, 0, 1 so the URL leaves no room for confusion
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
    timer: null,   // grace timer while disconnected
    queue: []      // messages to deliver when they come back
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
      try { slot.ws.send(JSON.stringify({ type: reason })); } catch { /* ignore */ }
    }
  }
}

function attach(ws, room, role) {
  ws.pongRoom = room;
  ws.pongRole = role;
}

/**
 * Wires a new client into the room system. Works with any `ws`-like
 * object (the `ws` library locally, or the socket handed over by
 * experimental_upgradeWebSocket on Vercel).
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
        // Match settings chosen by the host; the server is the single
        // source of truth and hands them to BOTH players in 'start'
        const seconds = Math.min(600, Math.max(10, Math.round(Number(msg.seconds)) || 240));
        const balls = Math.min(3, Math.max(1, Math.round(Number(msg.balls)) || 1));
        const room = {
          code,
          started: false,
          host: newSlot(ws),
          guest: null,
          config: { seconds, balls },
          // The server remembers the score so a reloaded phone can
          // pick the match back up without losing it
          score: { host: 0, guest: 0 },
          rematchVotes: new Set()
        };
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
        // The host serves first; if they are away (sharing the link),
        // they get the queued 'start' when they resume.
        slotSend(room.host, { type: 'start', role: 'host', code, token: room.host.token, config: room.config });
        slotSend(room.guest, { type: 'start', role: 'guest', code, token: room.guest.token, config: room.config });
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
        // Close any zombie connection left behind
        if (slot.ws && slot.ws !== ws) {
          try { slot.ws.close(); } catch { /* ignore */ }
        }
        clearTimeout(slot.timer);
        slot.timer = null;
        slot.ws = ws;
        attach(ws, room, role);
        const peerRole = role === 'host' ? 'guest' : 'host';
        slotSend(slot, {
          type: 'resumed',
          role,
          started: room.started,
          config: room.config,
          score: { you: room.score[role], rival: room.score[peerRole] }
        });
        // Deliver whatever happened while they were away, in order
        const pending = slot.queue.splice(0);
        for (const data of pending) {
          if (ws.readyState === OPEN) ws.send(data);
        }
        const peer = peerSlotOf(room, role);
        if (peer) slotSend(peer, { type: 'peer_back' });
        break;
      }

      // Voluntary exit: destroy the room right away, no grace period
      case 'leave': {
        const room = ws.pongRoom;
        if (room) destroyRoom(room, 'peer_left');
        break;
      }

      // Everything else (ball, goals, rematch...) is relayed to the rival.
      default: {
        const room = ws.pongRoom;
        if (!room || rooms.get(room.code) !== room) break;
        // Bookkeeping so resumes can restore the match state
        if (msg.type === 'goal') {
          // The sender is the one who conceded the point
          const me = ws.pongRole;
          const peer = me === 'host' ? 'guest' : 'host';
          room.score[me] = msg.conceder;
          room.score[peer] = msg.scorer;
          room.rematchVotes.clear();
        } else if (msg.type === 'rematch') {
          room.rematchVotes.add(ws.pongRole);
          if (room.rematchVotes.size === 2) {
            room.score.host = 0;
            room.score.guest = 0;
            room.rematchVotes.clear();
          }
        }
        slotSend(peerSlotOf(room, ws.pongRole), msg);
      }
    }
  });

  // Heartbeat to detect phones that lost signal
  const heartbeat = setInterval(() => {
    try {
      if (ws.readyState === OPEN && typeof ws.ping === 'function') ws.ping();
    } catch { /* ignore */ }
  }, 30000);

  ws.on('close', () => {
    clearInterval(heartbeat);
    const room = ws.pongRoom;
    if (!room || rooms.get(room.code) !== room) return;
    const slot = ws.pongRole === 'host' ? room.host : room.guest;
    if (!slot || slot.ws !== ws) return; // already resumed on another connection

    // Don't destroy the room: give them a grace period to come back
    slot.ws = null;
    const peer = peerSlotOf(room, ws.pongRole);
    if (peer) slotSend(peer, { type: 'peer_away' });
    slot.timer = setTimeout(() => {
      destroyRoom(room, 'peer_left');
    }, GRACE_MS);
  });
}
