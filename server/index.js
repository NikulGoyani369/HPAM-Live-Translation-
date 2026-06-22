const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// Track rooms: { roomId: { translator: socketId | null, listeners: Set<socketId> } }
const rooms = {};

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = { translator: null, listeners: new Set() };
  }
  return rooms[roomId];
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ─── Translator joins ──────────────────────────────────────────────
  socket.on('translator:join', ({ roomId }) => {
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

    // Notify all listeners that translator is live
    socket.to(roomId).emit('translator:online');
  });

  // ─── Listener joins ────────────────────────────────────────────────
  socket.on('listener:join', ({ roomId }) => {
    const room = getOrCreateRoom(roomId);

    room.listeners.add(socket.id);
    socket.join(roomId);
    socket.data.role = 'listener';
    socket.data.roomId = roomId;

    const translatorOnline = !!room.translator;
    console.log(`[L] Listener joined room: ${roomId} (translator online: ${translatorOnline})`);

    socket.emit('listener:joined', { roomId, translatorOnline });

    // Update listener count for translator
    if (room.translator) {
      io.to(room.translator).emit('listener:count', { count: room.listeners.size });
    }

    // If translator is online, ask translator to initiate offer to this listener
    if (room.translator) {
      io.to(room.translator).emit('listener:new', { listenerId: socket.id });
    }
  });

  // ─── WebRTC Signaling ──────────────────────────────────────────────
  socket.on('signal:offer', ({ to, offer }) => {
    io.to(to).emit('signal:offer', { from: socket.id, offer });
  });

  socket.on('signal:answer', ({ to, answer }) => {
    io.to(to).emit('signal:answer', { from: socket.id, answer });
  });

  socket.on('signal:ice', ({ to, candidate }) => {
    io.to(to).emit('signal:ice', { from: socket.id, candidate });
  });

  // ─── Disconnect ────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { role, roomId } = socket.data;
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

    // Clean up empty rooms
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
