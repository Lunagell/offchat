import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

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

const ALLOWED_TTL = [10, 15, 30];
const DEFAULT_TTL = 10;

// ─── Room Management ─────────────────────────────────────────────────
function getRoom(name, passwordHash = null, ttlMinutes = DEFAULT_TTL) {
  if (!rooms.has(name)) {
    const ttl = ALLOWED_TTL.includes(ttlMinutes) ? ttlMinutes : DEFAULT_TTL;
    const ttlMs = ttl * 60 * 1000;

    rooms.set(name, {
      name,
      clients: new Map(),
      createdAt: Date.now(),
      ttlMs,
      timer: setTimeout(() => destroyRoom(name), ttlMs),
      usedCodenames: new Set(),
      passwordHash,
    });
  }
  return rooms.get(name);
}

function destroyRoom(name) {
  const room = rooms.get(name);
  if (!room) return;

  for (const [ws] of room.clients) {
    try { ws.send(JSON.stringify({ type: 'destroyed' })); } catch { }
    ws.close();
  }

  clearTimeout(room.timer);
  rooms.delete(name);
}

function manualDestroyRoom(name) {
  const room = rooms.get(name);
  if (!room) return;

  // Broadcast manual destroy — clients will play shatter effect
  const msg = JSON.stringify({ type: 'destroyed', manual: true });
  for (const [ws] of room.clients) {
    try { ws.send(msg); } catch { }
  }

  clearTimeout(room.timer);

  // Give clients time to receive the message, then clean up
  setTimeout(() => {
    const r = rooms.get(name);
    if (r) {
      for (const [ws] of r.clients) {
        ws.close();
      }
      rooms.delete(name);
    }
  }, 2500);
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

  // ─── API: room info ──────────────────────────────────────────────
  if (url.pathname === '/api/room-info') {
    const roomName = url.searchParams.get('room');
    res.setHeader('Content-Type', 'application/json');

    if (!roomName) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'missing room name' }));
      return;
    }

    const room = rooms.get(roomName);
    if (!room) {
      res.writeHead(200);
      res.end(JSON.stringify({ exists: false, hasPassword: false }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({
      exists: true,
      hasPassword: !!room.passwordHash,
      participants: room.clients.size,
    }));
    return;
  }

  // ─── API: QR code ────────────────────────────────────────────────
  if (url.pathname === '/api/qr') {
    const roomName = url.searchParams.get('room');
    if (!roomName) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('missing room');
      return;
    }

    try {
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host;
      const roomUrl = `${proto}://${host}/${encodeURIComponent(roomName)}`;

      const svg = await QRCode.toString(roomUrl, {
        type: 'svg',
        margin: 2,
        width: 220,
        color: {
          dark: '#00ffa3',
          light: '#00000000', // transparent
        },
      });

      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(svg);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('qr generation failed');
    }
    return;
  }

  let filePath;

  if (url.pathname === '/') {
    filePath = join(__dirname, 'public', 'index.html');
  } else if (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/')
  ) {
    filePath = join(__dirname, 'public', url.pathname);
  } else {
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
const MAX_PAYLOAD = 50 * 1024 * 1024;
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomName = url.searchParams.get('room');
  const hasPassword = url.searchParams.get('hasPassword') === '1';
  const pwdHash = url.searchParams.get('pwdHash') || '';
  const ttl = parseInt(url.searchParams.get('ttl') || String(DEFAULT_TTL), 10);

  if (!roomName || roomName.length > 64) {
    ws.close(4001, 'invalid room');
    return;
  }

  const existingRoom = rooms.get(roomName);

  if (existingRoom) {
    if (existingRoom.passwordHash) {
      if (!pwdHash || pwdHash !== existingRoom.passwordHash) {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'wrong password' }));
        ws.close(4003, 'auth failed');
        return;
      }
    }
  }

  const room = existingRoom || getRoom(roomName, hasPassword ? pwdHash : null, ttl);

  const codename = assignCodename(room);
  room.clients.set(ws, codename);

  ws.send(JSON.stringify({
    type: 'init',
    codename,
    participants: room.clients.size,
    expiresAt: room.createdAt + room.ttlMs,
    createdAt: room.createdAt,
    hasPassword: !!room.passwordHash,
  }));

  broadcast(room, {
    type: 'join',
    codename,
    participants: room.clients.size,
  }, ws);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'message') {
        if (!msg.encrypted || !msg.iv) return;
        broadcast(room, {
          type: 'message',
          codename,
          encrypted: msg.encrypted,
          iv: msg.iv,
          timestamp: Date.now(),
        }, ws);

      } else if (msg.type === 'file') {
        if (!msg.data || !msg.dataIv || !msg.meta || !msg.metaIv) return;
        broadcast(room, {
          type: 'file',
          codename,
          data: msg.data,
          dataIv: msg.dataIv,
          meta: msg.meta,
          metaIv: msg.metaIv,
          timestamp: Date.now(),
        }, ws);

      } else if (msg.type === 'typing') {
        broadcast(room, { type: 'typing', codename }, ws);

      } else if (msg.type === 'destroy') {
        manualDestroyRoom(roomName);
      }
    } catch {
      // silently drop malformed
    }
  });

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
