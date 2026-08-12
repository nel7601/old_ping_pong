/*
 * Endpoint WebSocket para Vercel (beta pública de WebSockets, junio 2026).
 *
 * Corre sobre Fluid compute: la conexión queda anclada a la instancia
 * de la función mientras dure la partida. La lógica de salas vive en
 * lib/rooms.js, la misma que usa server.js en local.
 */

import { experimental_upgradeWebSocket } from '@vercel/functions';
import { handleConnection } from '../lib/rooms.js';

export function GET() {
  return experimental_upgradeWebSocket((ws) => {
    handleConnection(ws);
  });
}
