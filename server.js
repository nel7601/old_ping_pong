/*
 * OLD PING PONG - servidor para local / VPS
 *
 * Sirve el cliente (carpeta public/) por HTTP y acepta los WebSockets
 * en /api/ws — la misma ruta que usa el despliegue en Vercel, así el
 * cliente no distingue entre entornos. La lógica de salas está en
 * lib/rooms.js.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { handleConnection } from './lib/rooms.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

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

const wss = new WebSocketServer({ server, path: '/api/ws' });
wss.on('connection', handleConnection);

server.listen(PORT, () => {
  console.log(`OLD PING PONG escuchando en http://localhost:${PORT}`);
});
