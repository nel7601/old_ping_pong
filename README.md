# OLD PING PONG

Recreación del **Pong** original (Atari, 1972) para dos teléfonos conectados
por internet. Muy simple, muy old fashion: negro, blanco y *beeps*.

## Cómo funciona

- Cada jugador abre el juego en el **navegador de su teléfono** (no hace falta
  instalar nada de una tienda de apps).
- Un jugador pulsa **CREAR PARTIDA** y obtiene un **enlace para compartir**
  (por WhatsApp, SMS, o como quiera).
- El otro jugador simplemente **abre el enlace** y la partida empieza. Los
  jugadores pueden estar en **redes distintas y en cualquier parte del mundo**:
  ambos teléfonos se conectan al servidor por WebSocket y este los empareja.
- Cada teléfono muestra **su mitad de la mesa**: tu paleta abajo y la red
  (línea discontinua) arriba. Cuando la bola sale por la parte de arriba de tu
  pantalla, **entra por la pantalla del rival**.
- El **marcador es compartido** y se ve en ambos teléfonos. Gana el primero
  que llegue a **11 puntos**. El que falla vuelve a sacar.
- Controles: **arrastra el dedo** por la pantalla para mover tu paleta.

## Arquitectura

```
teléfono 1  ──WebSocket──►  servidor (relay + salas)  ◄──WebSocket──  teléfono 2
```

- `lib/rooms.js` — la lógica de salas y relay (compartida por los dos entornos).
- `server.js` — servidor Node.js para local o VPS: sirve el cliente y acepta
  WebSockets en `/api/ws`. No simula el juego.
- `api/ws.js` — el mismo relay como función de Vercel (WebSockets nativos).
- `public/` — el cliente: HTML5 canvas con controles táctiles.
- La **física de la bola la calcula solo el teléfono en cuyo campo está** la
  bola. Al cruzar la red se envía al rival su posición y velocidad (espejadas,
  porque los jugadores están "frente a frente"). Así no hay problemas de
  sincronización ni de latencia durante el juego.

## Ejecutar en local

```bash
npm install
npm start
# abre http://localhost:3000 en dos pestañas o dos dispositivos de la misma red
```

## Desplegar en Vercel (para jugar entre distintas redes)

El proyecto ya está preparado para Vercel, que soporta WebSockets de forma
nativa (beta pública desde junio de 2026, sobre Fluid compute):

1. Entra en [vercel.com](https://vercel.com) e inicia sesión con tu cuenta de GitHub.
2. **Add New… → Project** e importa el repositorio `old_ping_pong`.
3. No cambies nada (framework "Other", sin build command) y pulsa **Deploy**.
4. Comparte la URL resultante (`https://tu-proyecto.vercel.app`) con los dos
   jugadores y a jugar.

Notas de la beta de WebSockets de Vercel:

- **Fluid compute debe estar activo** (viene activado por defecto en
  proyectos nuevos: Settings → Functions → Fluid Compute).
- La conexión dura como máximo `maxDuration` (300 s en el plan Hobby, 5 min,
  configurado en `vercel.json`). Si una partida llega al límite, la conexión
  se corta y hay que crear sala de nuevo. En planes de pago se puede subir
  hasta 800 s.
- Las salas viven en memoria de la instancia. Si al abrir un enlace válido
  aparece «PARTIDA NO ENCONTRADA», es que las dos conexiones cayeron en
  instancias distintas (raro con poco tráfico): cread la partida de nuevo
  y reintentad.

## Desplegar en otro sitio

También es una app Node.js estándar con un solo puerto (`PORT`): funciona tal
cual en **Render**, **Railway**, **Fly.io** o un VPS propio con `npm start`.
El cliente usa automáticamente `wss://` cuando la página se sirve por HTTPS.
