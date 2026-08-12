/*
 * WebSocket endpoint for Vercel (WebSockets public beta, June 2026).
 *
 * Runs on Fluid compute: the connection stays pinned to the function
 * instance for the duration of the match. Room logic lives in
 * lib/rooms.js, the same code server.js uses locally.
 */

import { experimental_upgradeWebSocket } from '@vercel/functions';
import { handleConnection } from '../lib/rooms.js';

export function GET() {
  return experimental_upgradeWebSocket((ws) => {
    handleConnection(ws);
  });
}
