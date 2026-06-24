import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';

interface Room {
  translator: string | null;
  listeners: Set<string>;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, '../../public')));
app.use(express.json());

const rooms: Record<string, Room> = {};

app.get('/api/status/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  res.json({ live: !!(room && room.translator), listeners: room ? room.listeners.size : 0 });
});

const pinAttempts = new Map<string, { count: number; resetAt: number }>();
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = pinAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    pinAttempts.set(ip, { count: 1, resetAt: now + PIN_LOCKOUT_MS });
    return true;
  }
  if (entry.count >= PIN_MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

app.post('/api/verify-pin', (req, res) => {
  if (!process.env.TRANSLATOR_PIN) {
    res.status(503).json({ ok: false, reason: 'not_configured' });
    return;
  }
  const ip = req.ip ?? 'unknown';
  if (!checkRateLimit(ip)) {
    res.status(429).json({ ok: false, reason: 'too_many_attempts' });
    return;
  }
  const { pin } = req.body as { pin?: string };
  if (pin === process.env.TRANSLATOR_PIN) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

function getOrCreateRoom(roomId: string): Room {
  if (!rooms[roomId]) {
    rooms[roomId] = { translator: null, listeners: new Set() };
  }
  return rooms[roomId];
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  socket.on('translator:join', ({ roomId, pin }: { roomId: string; pin: string }) => {
    if (!process.env.TRANSLATOR_PIN) {
      socket.emit('error', { message: 'Translator access not configured.' });
      return;
    }
    if (pin !== process.env.TRANSLATOR_PIN) {
      socket.emit('error', { message: 'Incorrect PIN.' });
      return;
    }

    const room = getOrCreateRoom(roomId);

    if (room.translator && room.translator !== socket.id) {
      socket.emit('error', { message: 'A translator is already active in this room.' });
      return;
    }

    room.translator = socket.id;
    socket.join(roomId);
    socket.data.role = 'translator';
    socket.data.roomId = roomId;

    console.log(`[T] Translator joined room: ${roomId}`);
    socket.emit('translator:joined', { roomId, listenerCount: room.listeners.size });
    socket.to(roomId).emit('translator:online');
  });

  socket.on('listener:join', ({ roomId }: { roomId: string }) => {
    const room = getOrCreateRoom(roomId);

    room.listeners.add(socket.id);
    socket.join(roomId);
    socket.data.role = 'listener';
    socket.data.roomId = roomId;

    const translatorOnline = !!room.translator;
    console.log(`[L] Listener joined room: ${roomId} (translator online: ${translatorOnline})`);

    socket.emit('listener:joined', { roomId, translatorOnline });
  });

  socket.on('audio:chunk', (chunk: ArrayBuffer) => {
    const { role, roomId } = socket.data as { role?: string; roomId?: string };
    if (role !== 'translator' || !roomId) return;
    socket.to(roomId).emit('audio:chunk', chunk);
  });

  socket.on('disconnect', () => {
    const { role, roomId } = socket.data as { role?: string; roomId?: string };
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];

    if (role === 'translator') {
      room.translator = null;
      console.log(`[T] Translator left room: ${roomId}`);
      io.to(roomId).emit('translator:offline');
    } else if (role === 'listener') {
      room.listeners.delete(socket.id);
      console.log(`[L] Listener left room: ${roomId}`);
      if (room.translator) {
        io.to(room.translator).emit('listener:count', { count: room.listeners.size });
      }
    }

    if (!room.translator && room.listeners.size === 0) {
      delete rooms[roomId];
    }

    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ HPAM Translation Server running on http://localhost:${PORT}`);
  console.log(`   Translator: http://localhost:${PORT}/translator.html`);
  console.log(`   Listener:   http://localhost:${PORT}/listener.html`);
});
