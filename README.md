# OLD PING PONG

A recreation of the original **Pong** (Atari, 1972) for two phones connected
over the internet. Very simple, very old fashioned: black, white and *beeps*.

## How it works

- Each player opens the game in their **phone's browser** (nothing to
  install from an app store).
- One player taps **CREATE GAME** and gets a **link to share** (WhatsApp,
  SMS, whatever).
- The other player simply **opens the link** and the match starts. Players
  can be on **different networks anywhere in the world**: both phones
  connect to the server over WebSocket and it pairs them up.
- Each phone shows **its half of the table**: the top 4/5 of the screen is
  the active play area and the bottom fifth is the info zone (score and
  status), separated by a dashed line with your paddle resting on it. When
  the ball flies off the top of your screen, it **enters your rival's
  screen**.
- The **score is shared** and shown on both phones. First to **11 points**
  wins. Whoever misses serves next.
- Controls: **drag your finger** across the screen to move your paddle.
- If a phone leaves the browser for any reason (sharing the link, a call,
  a notification, the browser being killed or even reloaded) the game
  **pauses** and the seat is held for **10 minutes**; the session, the
  score and the match resume automatically when the player comes back.

## Architecture

```
phone 1  ──WebSocket──►  server (relay + rooms)  ◄──WebSocket──  phone 2
```

- `lib/rooms.js` — room, relay and resume logic (shared by both environments).
- `server.js` — Node.js server for local play or a VPS: serves the client
  and accepts WebSockets at `/api/ws`. It does not simulate the game.
- `api/ws.js` — the same relay as a Vercel function (native WebSockets).
- `public/` — the client: HTML5 canvas with touch controls.
- **Ball physics run only on the phone whose court the ball is in.** When
  it crosses the top edge, its position and velocity are sent to the rival
  (mirrored, since the players face each other). That way there are no
  synchronization or latency issues during play.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000 in two tabs or two devices on the same network
```

## Deploy on Vercel (to play across different networks)

The project is ready for Vercel, which supports WebSockets natively
(public beta since June 2026, on Fluid compute):

1. Go to [vercel.com](https://vercel.com) and sign in with your GitHub account.
2. **Add New… → Project** and import the `old_ping_pong` repository.
3. Change nothing (framework "Other", no build command) and hit **Deploy**.
4. Share the resulting URL (`https://your-project.vercel.app`) with both
   players and play.

Notes on Vercel's WebSocket beta:

- **Fluid compute must be on** (it is by default for new projects:
  Settings → Functions → Fluid Compute).
- A connection lasts at most `maxDuration` (300 s on the Hobby plan,
  5 minutes, set in `vercel.json`). If a match hits the limit the
  connection drops and you need to create a new game. Paid plans can
  raise it up to 800 s.
- Rooms live in the instance's memory. If opening a valid link shows
  "GAME NOT FOUND", the two connections landed on different instances
  (rare with low traffic): create a new game and retry.

## Deploy elsewhere

It is also a standard Node.js app with a single port (`PORT`): it works
as-is on **Render**, **Railway**, **Fly.io** or your own VPS with
`npm start`. The client automatically uses `wss://` when the page is
served over HTTPS.
