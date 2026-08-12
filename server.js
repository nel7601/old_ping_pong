/*
 * OLD PING PONG - servidor
 *
 * Sirve el cliente (carpeta public/) por HTTP y actúa como relay
 * WebSocket entre los dos teléfonos. Los jugadores pueden estar en
 * redes distintas: ambos se conectan a este servidor y se emparejan
 * mediante un código de sala de 4 letras.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);

  // Nunca servir fuera de public/
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- Salas ----------------------------------------------------------------

// code -> { host: ws, guest: ws | null }
const rooms = new Map();

// Sin I, O, 0, 1 para evitar confusiones al dictar el código
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function peerOf(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return null;
  return ws === room.host ? room.guest : room.host;
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
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

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const peer = peerOf(ws);
    rooms.delete(ws.roomCode);
    if (peer) {
      peer.roomCode = undefined;
      send(peer, { type: 'peer_left' });
    }
  });
});

// Limpieza de conexiones muertas (teléfonos que perdieron señal)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`OLD PING PONG escuchando en http://localhost:${PORT}`);
});
