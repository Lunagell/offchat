import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3000;

// ─── In-Memory Rooms ────────────────────────────────────────────────
const rooms = new Map();

const CODENAMES = [
  'Phantom', 'Specter', 'Ghost', 'Shadow', 'Cipher', 'Vector',
  'Null', 'Void', 'Echo', 'Delta', 'Omega', 'Raven', 'Viper',
  'Hawk', 'Wolf', 'Fox', 'Lynx', 'Cobra', 'Mantis', 'Wraith',
  'Onyx', 'Nyx', 'Zero', 'Apex', 'Flare', 'Pulse', 'Drift',
  'Storm', 'Frost', 'Blaze', 'Shard', 'Vertex', 'Helix', 'Prism',
];

const ROOM_TTL = 10 * 60 * 1000; // 10 minutes

// ─── Room Management ─────────────────────────────────────────────────
function getRoom(name) {
  if (!rooms.has(name)) {
    rooms.set(name, {
      name,
      clients: new Map(),
      createdAt: Date.now(),
      timer: setTimeout(() => destroyRoom(name), ROOM_TTL),
      usedCodenames: new Set(),
    });
  }
  return rooms.get(name);
}

function destroyRoom(name) {
  const room = rooms.get(name);
  if (!room) return;

  for (const [ws] of room.clients) {
    ws.send(JSON.stringify({ type: 'destroyed' }));
    ws.close();
  }

  clearTimeout(room.timer);
  rooms.delete(name);
}

function assignCodename(room) {
  const available = CODENAMES.filter(n => !room.usedCodenames.has(n));
  if (available.length === 0) {
    return `Agent-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  }
  const codename = available[Math.floor(Math.random() * available.length)];
  room.usedCodenames.add(codename);
  return codename;
}

function broadcast(room, data, exclude = null) {
  const msg = JSON.stringify(data);
  for (const [client] of room.clients) {
    if (client !== exclude && client.readyState === 1) {
      client.send(msg);
    }
  }
}

// ─── MIME Types ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ─── Security Headers ───────────────────────────────────────────────
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()'
  );
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    "script-src 'self'",
    "connect-src 'self' ws: wss:",
    "img-src 'self' data: blob:",
  ].join('; '));
}

// ─── HTTP Server ─────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  setSecurityHeaders(res);

  let filePath;

  if (url.pathname === '/') {
    filePath = join(__dirname, 'public', 'index.html');
  } else if (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/')
  ) {
    filePath = join(__dirname, 'public', url.pathname);
  } else {
    // Any other path → serve chat room
    filePath = join(__dirname, 'public', 'chat.html');
  }

  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

// ─── WebSocket Server ────────────────────────────────────────────────
const MAX_PAYLOAD = 50 * 1024 * 1024; // 50MB for file transfers
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomName = url.searchParams.get('room');

  if (!roomName || roomName.length > 64) {
    ws.close(4001, 'invalid room');
    return;
  }

  const room = getRoom(roomName);
  const codename = assignCodename(room);
  room.clients.set(ws, codename);

  // Send init
  ws.send(JSON.stringify({
    type: 'init',
    codename,
    participants: room.clients.size,
    expiresAt: room.createdAt + ROOM_TTL,
    createdAt: room.createdAt,
  }));

  // Broadcast join
  broadcast(room, {
    type: 'join',
    codename,
    participants: room.clients.size,
  }, ws);

  // Handle messages
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'message') {
        if (!msg.encrypted || !msg.iv) return;
        // Relay encrypted text — server CANNOT read this
        broadcast(room, {
          type: 'message',
          codename,
          encrypted: msg.encrypted,
          iv: msg.iv,
          timestamp: Date.now(),
        }, ws);
      } else if (msg.type === 'file') {
        if (!msg.data || !msg.dataIv || !msg.meta || !msg.metaIv) return;
        // Relay encrypted file — server sees NOTHING
        broadcast(room, {
          type: 'file',
          codename,
          data: msg.data,
          dataIv: msg.dataIv,
          meta: msg.meta,
          metaIv: msg.metaIv,
          timestamp: Date.now(),
        }, ws);
      }
    } catch {
      // silently drop malformed messages
    }
  });

  // Handle disconnect
  ws.on('close', () => {
    room.clients.delete(ws);
    room.usedCodenames.delete(codename);

    broadcast(room, {
      type: 'leave',
      codename,
      participants: room.clients.size,
    });

    if (room.clients.size === 0) {
      destroyRoom(roomName);
    }
  });
});

// ─── Start ───────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\x1b[38;2;0;255;163m[offchat]\x1b[0m live on port ${PORT}`);
  console.log(`\x1b[38;2;64;64;88m         http://localhost:${PORT}\x1b[0m`);
});
