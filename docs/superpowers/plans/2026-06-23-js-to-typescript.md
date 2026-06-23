# JS → TypeScript Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert all JavaScript source files (server + 3 frontend files) to TypeScript, using esbuild to bundle the frontend and ts-node/tsc for the server.

**Architecture:** In-place rename of `.js` → `.ts`; no files move. The server stays CommonJS (tsc compiles to `dist/server/`). The three frontend files are bundled individually by esbuild into `public/dist/`. HTML files updated to load from `public/dist/` instead of `public/src/`, with socket.io-client bundled (no CDN tag).

**Tech Stack:** TypeScript 5.x, ts-node, esbuild, concurrently, socket.io-client (npm, not CDN), @types/node, @types/express

## Global Constraints

- `strict: true` in both tsconfig files — no `any` shortcuts except where noted
- Server module system stays CommonJS — no ESM migration
- All existing runtime behavior must be unchanged — no logic edits, only type annotations
- `public/dist/` is gitignored — never commit build output
- Socket.io-client loaded via npm + esbuild bundle, not CDN — remove CDN `<script>` tags from HTML

---

### Task 1: Install dependencies and scaffold TypeScript config

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`
- Create: `server/tsconfig.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm run typecheck`, `npm run build`, `npm run dev`, `npm start` scripts

- [ ] **Step 1: Install all new packages**

Run from the project root:
```bash
npm install socket.io-client
npm install --save-dev typescript ts-node @types/node @types/express esbuild concurrently
```

Expected: packages added to `node_modules/`, `package.json` and `package-lock.json` updated.

- [ ] **Step 2: Update `package.json` scripts**

Replace the `"scripts"` block in `package.json` with:
```json
"scripts": {
  "build": "tsc -p server/tsconfig.json && esbuild public/src/index.ts public/src/translator.ts public/src/listener.ts --bundle --outdir=public/dist --minify",
  "dev": "concurrently \"nodemon --exec ts-node server/index.ts\" \"esbuild public/src/index.ts public/src/translator.ts public/src/listener.ts --bundle --outdir=public/dist --watch\"",
  "start": "node dist/server/index.js",
  "typecheck": "tsc --noEmit && tsc -p server/tsconfig.json --noEmit"
}
```

- [ ] **Step 3: Create root `tsconfig.json`** (frontend — browser target, no emit)

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["DOM", "ES2020"],
    "strict": true,
    "noEmit": true,
    "moduleResolution": "bundler"
  },
  "include": ["public/src"]
}
```

- [ ] **Step 4: Create `server/tsconfig.json`** (CommonJS, emits to `dist/server/`)

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "lib": ["ES2020"],
    "strict": true,
    "outDir": "../dist/server",
    "rootDir": "."
  },
  "include": ["."]
}
```

- [ ] **Step 5: Update `.gitignore`** — add `public/dist/` and `dist/` to prevent committing build output

Open `.gitignore` and append:
```
dist/
public/dist/
```

- [ ] **Step 6: Verify setup**

Run:
```bash
npx tsc --version
```
Expected: `Version 5.x.x` (any 5.x)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json server/tsconfig.json .gitignore
git commit -m "chore: add TypeScript + esbuild toolchain"
```

---

### Task 2: Convert `server/index.js` → `server/index.ts`

**Files:**
- Rename + modify: `server/index.js` → `server/index.ts`

**Interfaces:**
- Consumes: `npm run typecheck` from Task 1
- Produces: typed server with `Room` interface, typed socket event payloads

- [ ] **Step 1: Rename the file**

```bash
git mv server/index.js server/index.ts
```

- [ ] **Step 2: Replace the file contents with the typed version**

Write the following to `server/index.ts`:

```typescript
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';

interface Room {
  translator: string | null;
  listeners: Set<string>;
}

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, '../public')));

const rooms: Record<string, Room> = {};

app.get('/api/ice-servers', (_req, res) => {
  const iceServers: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    const urls = process.env.TURN_URLS.split(',').map(u => u.trim());
    iceServers.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.json({ iceServers });
});

app.get('/api/status/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  res.json({ live: !!(room && room.translator), listeners: room ? room.listeners.size : 0 });
});

function getOrCreateRoom(roomId: string): Room {
  if (!rooms[roomId]) {
    rooms[roomId] = { translator: null, listeners: new Set() };
  }
  return rooms[roomId];
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  socket.on('translator:join', ({ roomId }: { roomId: string }) => {
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

    if (room.translator) {
      io.to(room.translator).emit('listener:count', { count: room.listeners.size });
    }

    if (room.translator) {
      io.to(room.translator).emit('listener:new', { listenerId: socket.id });
    }
  });

  socket.on('signal:offer', ({ to, offer }: { to: string; offer: unknown }) => {
    io.to(to).emit('signal:offer', { from: socket.id, offer });
  });

  socket.on('signal:answer', ({ to, answer }: { to: string; answer: unknown }) => {
    io.to(to).emit('signal:answer', { from: socket.id, answer });
  });

  socket.on('signal:ice', ({ to, candidate }: { to: string; candidate: unknown }) => {
    io.to(to).emit('signal:ice', { from: socket.id, candidate });
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
```

> **Note:** Signal payloads (`offer`, `answer`, `candidate`) are typed as `unknown` — the server forwards them opaquely without inspecting their shape, and `RTCSessionDescriptionInit`/`RTCIceCandidateInit` are browser-only DOM types not available in the server's tsconfig.

- [ ] **Step 3: Verify the server type-checks**

```bash
npx tsc -p server/tsconfig.json --noEmit
```

Expected: no output (zero errors).

If you see `error TS2307: Cannot find module 'express'` — run `npm install` again.
If you see `error TS2345` on signal payloads — ensure the payload types are `unknown` as shown above.

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat: convert server/index.js to TypeScript"
```

---

### Task 3: Convert `public/src/index.js` → `public/src/index.ts`

**Files:**
- Rename + modify: `public/src/index.js` → `public/src/index.ts`

**Interfaces:**
- Consumes: root `tsconfig.json` from Task 1
- Produces: typed status-polling module

- [ ] **Step 1: Rename the file**

```bash
git mv public/src/index.js public/src/index.ts
```

- [ ] **Step 2: Replace the file contents**

Write the following to `public/src/index.ts`:

```typescript
interface StatusResponse {
  live: boolean;
  listeners: number;
}

const badge = document.getElementById('liveBadge') as HTMLElement;
const liveText = document.getElementById('liveText') as HTMLElement;

function checkStatus(): void {
  fetch('/api/status/hpam-english')
    .then(r => r.json() as Promise<StatusResponse>)
    .then(({ live, listeners }) => {
      if (live) {
        badge.classList.add('live');
        liveText.textContent = `Translator is LIVE · ${listeners} listening`;
      } else {
        badge.classList.remove('live');
        liveText.textContent = 'Translation not started yet';
      }
    })
    .catch(() => { liveText.textContent = 'Status unavailable'; });
}

checkStatus();
setInterval(checkStatus, 5000);
```

- [ ] **Step 3: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: no output. If there are errors only from `translator.ts` or `listener.ts` (not yet converted), that's fine — they'll be resolved in Tasks 4 and 5.

- [ ] **Step 4: Commit**

```bash
git add public/src/index.ts
git commit -m "feat: convert public/src/index.js to TypeScript"
```

---

### Task 4: Convert `public/src/translator.js` → `public/src/translator.ts`

**Files:**
- Rename + modify: `public/src/translator.js` → `public/src/translator.ts`

**Interfaces:**
- Consumes: `socket.io-client` npm package (installed in Task 1), root `tsconfig.json`
- Produces: fully typed translator broadcast module

- [ ] **Step 1: Rename the file**

```bash
git mv public/src/translator.js public/src/translator.ts
```

- [ ] **Step 2: Replace the file contents**

Write the following to `public/src/translator.ts`:

```typescript
import { io, Socket } from 'socket.io-client';

const ROOM_ID = 'hpam-english';
const SERVER_URL = window.location.origin;

let socket: Socket | null = null;
let localStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let animFrame = 0;
let peers: Record<string, RTCPeerConnection> = {};
let listenerCount = 0;
let connectedPeers = 0;
let startTime: number | null = null;
let timerInterval: number | null = null;
let isLive = false;
let isMuted = false;
let iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

fetch('/api/ice-servers')
  .then(r => r.json() as Promise<{ iceServers: RTCIceServer[] }>)
  .then(d => { iceServers = d.iceServers; })
  .catch(() => {});

const goLiveBtn       = document.getElementById('goLiveBtn') as HTMLButtonElement;
const muteBtn         = document.getElementById('muteBtn') as HTMLButtonElement;
const stopBtn         = document.getElementById('stopBtn') as HTMLButtonElement;
const micSelect       = document.getElementById('micSelect') as HTMLSelectElement;
const micField        = document.getElementById('micField') as HTMLElement;
const dot             = document.getElementById('dot') as HTMLElement;
const statusMsg       = document.getElementById('statusMsg') as HTMLElement;
const listenerCountEl = document.getElementById('listenerCount') as HTMLElement;
const durationEl      = document.getElementById('durationEl') as HTMLElement;
const peersEl         = document.getElementById('peersEl') as HTMLElement;
const shareBox        = document.getElementById('shareBox') as HTMLElement;
const shareUrl        = document.getElementById('shareUrl') as HTMLElement;
const copyBtn         = document.getElementById('copyBtn') as HTMLButtonElement;
const bars            = document.querySelectorAll('.bar') as NodeListOf<HTMLElement>;

async function loadMics(): Promise<void> {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    micSelect.innerHTML = mics.map((m, i) =>
      `<option value="${m.deviceId}">${m.label || 'Microphone ' + (i + 1)}</option>`
    ).join('');
  } catch {
    micSelect.innerHTML = '<option value="">Default microphone</option>';
  }
}
loadMics();

function startTimer(): void {
  startTime = Date.now();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - (startTime as number)) / 1000);
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    durationEl.textContent = `${m}:${(s % 60).toString().padStart(2, '0')}`;
  }, 1000);
}

function stopTimer(): void {
  if (timerInterval !== null) clearInterval(timerInterval);
  timerInterval = null;
  durationEl.textContent = '00:00';
}

function startViz(stream: MediaStream): void {
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 32;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  animViz();
}

function animViz(): void {
  animFrame = requestAnimationFrame(animViz);
  if (!analyser) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  bars.forEach((bar, i) => {
    const idx = Math.floor(i * data.length / bars.length);
    const h = 4 + (data[idx] / 255) * 52;
    bar.style.height = h + 'px';
    bar.classList.toggle('active', data[idx] > 10);
  });
}

function stopViz(): void {
  cancelAnimationFrame(animFrame);
  audioCtx?.close();
  audioCtx = null;
  analyser = null;
  bars.forEach(b => { b.style.height = '4px'; b.classList.remove('active'); });
}

function createPeerForListener(listenerId: string): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers });

  localStream!.getTracks().forEach(t => pc.addTrack(t, localStream!));

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket!.emit('signal:ice', { to: listenerId, candidate });
  };

  pc.onconnectionstatechange = () => {
    if (['connected', 'completed'].includes(pc.connectionState)) {
      connectedPeers++;
    } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      connectedPeers = Math.max(0, connectedPeers - 1);
    }
    peersEl.textContent = String(connectedPeers);
  };

  peers[listenerId] = pc;
  return pc;
}

async function goLive(): Promise<void> {
  goLiveBtn.disabled = true;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: micSelect.value || undefined, echoCancellation: true, noiseSuppression: true }
    });
  } catch {
    statusMsg.textContent = 'Microphone access denied';
    dot.className = 'dot error';
    goLiveBtn.disabled = false;
    return;
  }

  startViz(localStream);
  isLive = true;

  socket = io(SERVER_URL);

  socket.on('connect', () => {
    socket!.emit('translator:join', { roomId: ROOM_ID });
  });

  socket.on('translator:joined', ({ listenerCount: lc }: { listenerCount: number }) => {
    listenerCount = lc;
    listenerCountEl.textContent = String(listenerCount);
    dot.className = 'dot live';
    statusMsg.textContent = 'You are live';
    startTimer();
    micField.classList.add('hidden');
    goLiveBtn.classList.add('hidden');
    muteBtn.classList.remove('hidden');
    stopBtn.classList.remove('hidden');
    const url = `${window.location.origin}/listener.html`;
    shareUrl.textContent = url;
    shareBox.classList.remove('hidden');
  });

  socket.on('listener:count', ({ count }: { count: number }) => {
    listenerCount = count;
    listenerCountEl.textContent = String(count);
  });

  socket.on('listener:new', async ({ listenerId }: { listenerId: string }) => {
    const pc = createPeerForListener(listenerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket!.emit('signal:offer', { to: listenerId, offer });
  });

  socket.on('signal:answer', async ({ from, answer }: { from: string; answer: RTCSessionDescriptionInit }) => {
    await peers[from]?.setRemoteDescription(answer);
  });

  socket.on('signal:ice', ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
    peers[from]?.addIceCandidate(candidate).catch(() => {});
  });

  socket.on('error', ({ message }: { message: string }) => {
    statusMsg.textContent = message;
    dot.className = 'dot error';
  });
}

function stopBroadcast(): void {
  isLive = false;
  localStream?.getTracks().forEach(t => t.stop());
  Object.values(peers).forEach(pc => pc.close());
  peers = {};
  socket?.disconnect();
  stopViz();
  stopTimer();
  connectedPeers = 0;
  listenerCount = 0;
  listenerCountEl.textContent = '0';
  peersEl.textContent = '0';
  dot.className = 'dot';
  statusMsg.textContent = 'Broadcast ended';
  isMuted = false;
  muteBtn.classList.add('hidden');
  muteBtn.classList.remove('muted');
  muteBtn.textContent = '🔇 Mute';
  stopBtn.classList.add('hidden');
  shareBox.classList.add('hidden');
  micField.classList.remove('hidden');
  goLiveBtn.classList.remove('hidden');
  goLiveBtn.disabled = false;
}

goLiveBtn.addEventListener('click', goLive);
stopBtn.addEventListener('click', stopBroadcast);

muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  localStream!.getTracks().forEach(t => { t.enabled = !isMuted; });
  muteBtn.textContent = isMuted ? '🎙 Unmute' : '🔇 Mute';
  muteBtn.classList.toggle('muted', isMuted);
  statusMsg.textContent = isMuted ? 'Muted — listeners cannot hear you' : 'You are live';
});

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(shareUrl.textContent ?? '').then(() => {
    copyBtn.textContent = '✅ Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy Link'; }, 2000);
  });
});
```

> **Note on `localStream!`:** Non-null assertion is intentional — `createPeerForListener` and the mute handler are only ever called when `localStream` is guaranteed to be set (after `goLive()` succeeds).

- [ ] **Step 3: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: zero errors for `translator.ts`. Any remaining errors will be from `listener.ts` (not yet converted) — those are fine.

- [ ] **Step 4: Commit**

```bash
git add public/src/translator.ts
git commit -m "feat: convert public/src/translator.js to TypeScript"
```

---

### Task 5: Convert `public/src/listener.js` → `public/src/listener.ts`

**Files:**
- Rename + modify: `public/src/listener.js` → `public/src/listener.ts`

**Interfaces:**
- Consumes: `socket.io-client` npm package (Task 1), root `tsconfig.json` (Task 1)
- Produces: fully typed listener WebRTC module

- [ ] **Step 1: Rename the file**

```bash
git mv public/src/listener.js public/src/listener.ts
```

- [ ] **Step 2: Replace the file contents**

Write the following to `public/src/listener.ts`:

```typescript
import { io, Socket } from 'socket.io-client';

const ROOM_ID = 'hpam-english';
const SERVER_URL = window.location.origin;

let socket: Socket | null = null;
let peerConn: RTCPeerConnection | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let animFrame = 0;
let audioEl: HTMLAudioElement | null = null;
let startTime: number | null = null;
let timerInterval: number | null = null;
let connected = false;
let translatorId: string | null = null;
let iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

fetch('/api/ice-servers')
  .then(r => r.json() as Promise<{ iceServers: RTCIceServer[] }>)
  .then(d => { iceServers = d.iceServers; })
  .catch(() => {});

const connectBtn   = document.getElementById('connectBtn') as HTMLButtonElement;
const stopBtn      = document.getElementById('stopBtn') as HTMLButtonElement;
const dot          = document.getElementById('dot') as HTMLElement;
const statusMsg    = document.getElementById('statusMsg') as HTMLElement;
const durationEl   = document.getElementById('duration') as HTMLElement;
const waitingMsg   = document.getElementById('waitingMsg') as HTMLElement;
const canvas       = document.getElementById('viz') as HTMLCanvasElement;
const ctx2d        = canvas.getContext('2d') as CanvasRenderingContext2D;
const volumeWrap   = document.getElementById('volumeWrap') as HTMLElement;
const volumeSlider = document.getElementById('volumeSlider') as HTMLInputElement;
const volumePct    = document.getElementById('volumePct') as HTMLElement;

volumeSlider.addEventListener('input', () => {
  if (audioEl) audioEl.volume = Number(volumeSlider.value);
  volumePct.textContent = Math.round(Number(volumeSlider.value) * 100) + '%';
  const pct = Number(volumeSlider.value) * 100;
  volumeSlider.style.background = `linear-gradient(to right, var(--gold) ${pct}%, rgba(255,255,255,0.1) ${pct}%)`;
});

function setStatus(text: string, state = ''): void {
  statusMsg.textContent = text;
  dot.className = 'status-dot' + (state ? ' ' + state : '');
}

function startTimer(): void {
  startTime = Date.now();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - (startTime as number)) / 1000);
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    durationEl.textContent = `${m}:${sec}`;
  }, 1000);
}

function stopTimer(): void {
  if (timerInterval !== null) clearInterval(timerInterval);
  timerInterval = null;
  durationEl.textContent = '00:00';
}

function startVisualizer(stream: MediaStream): void {
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  drawViz();
}

function drawViz(): void {
  animFrame = requestAnimationFrame(drawViz);
  if (!analyser) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const avg = data.reduce((a, b) => a + b, 0) / data.length;
  const r = 48 + avg * 0.12;
  const cx = 60, cy = 60;
  ctx2d.clearRect(0, 0, 120, 120);
  const grad = ctx2d.createRadialGradient(cx, cy, r - 4, cx, cy, r + 6);
  grad.addColorStop(0, `rgba(212,160,23,${0.15 + avg / 800})`);
  grad.addColorStop(1, 'rgba(212,160,23,0)');
  ctx2d.beginPath();
  ctx2d.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx2d.fillStyle = grad;
  ctx2d.fill();
  ctx2d.beginPath();
  ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
  ctx2d.strokeStyle = `rgba(212,160,23,${0.3 + avg / 400})`;
  ctx2d.lineWidth = 2.5;
  ctx2d.stroke();
}

function stopVisualizer(): void {
  cancelAnimationFrame(animFrame);
  audioCtx?.close();
  audioCtx = null;
  analyser = null;
  ctx2d.clearRect(0, 0, 120, 120);
}

function createPeerConn(): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && translatorId) socket!.emit('signal:ice', { to: translatorId, candidate });
  };

  pc.ontrack = (e) => {
    connected = true;
    audioEl = new Audio();
    audioEl.srcObject = e.streams[0];
    audioEl.volume = Number(volumeSlider.value);
    audioEl.play().catch(() => {});
    startVisualizer(e.streams[0]);
    setStatus('Live — English translation', 'live');
    startTimer();
    waitingMsg.classList.add('hidden');
    volumeWrap.classList.remove('hidden');
    stopBtn.classList.remove('hidden');
    connectBtn.classList.add('hidden');
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      setStatus('Connection lost — tap to retry');
      cleanup();
      connectBtn.classList.remove('hidden');
      connectBtn.textContent = '🔄 Reconnect';
      stopBtn.classList.add('hidden');
    }
  };

  return pc;
}

function connect(): void {
  connectBtn.disabled = true;
  setStatus('Connecting…');

  socket = io(SERVER_URL);

  socket.on('connect', () => {
    socket!.emit('listener:join', { roomId: ROOM_ID });
  });

  socket.on('listener:joined', ({ translatorOnline }: { translatorOnline: boolean }) => {
    peerConn = createPeerConn();
    if (!translatorOnline) {
      setStatus('Waiting for translator…');
      waitingMsg.classList.remove('hidden');
      connectBtn.disabled = false;
    } else {
      setStatus('Translator found — connecting…');
    }
  });

  socket.on('translator:online', () => {
    waitingMsg.classList.add('hidden');
    setStatus('Translator online — connecting…');
    if (!peerConn) peerConn = createPeerConn();
  });

  socket.on('translator:offline', () => {
    setStatus('Translator went offline');
    stopVisualizer();
    stopTimer();
    connected = false;
    waitingMsg.classList.remove('hidden');
  });

  socket.on('signal:offer', async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
    translatorId = from;
    if (!peerConn) peerConn = createPeerConn();
    await peerConn.setRemoteDescription(offer);
    const answer = await peerConn.createAnswer();
    await peerConn.setLocalDescription(answer);
    socket!.emit('signal:answer', { to: from, answer });
  });

  socket.on('signal:ice', ({ candidate }: { candidate: RTCIceCandidateInit }) => {
    peerConn?.addIceCandidate(candidate).catch(() => {});
  });

  socket.on('error', ({ message }: { message: string }) => {
    setStatus('Error: ' + message, 'error');
    connectBtn.disabled = false;
  });

  socket.on('disconnect', () => {
    if (connected) setStatus('Disconnected', 'error');
  });
}

function cleanup(): void {
  peerConn?.close();
  peerConn = null;
  socket?.disconnect();
  socket = null;
  translatorId = null;
  audioEl = null;
  stopVisualizer();
  stopTimer();
  connected = false;
  volumeWrap.classList.add('hidden');
  connectBtn.disabled = false;
}

connectBtn.addEventListener('click', connect);
stopBtn.addEventListener('click', () => {
  cleanup();
  setStatus('Stopped');
  stopBtn.classList.add('hidden');
  connectBtn.classList.remove('hidden');
  connectBtn.textContent = '🎧 Start Listening';
  waitingMsg.classList.add('hidden');
});
```

- [ ] **Step 3: Verify all frontend files type-check cleanly**

```bash
npx tsc --noEmit
```

Expected: **zero errors** across all three frontend files (`index.ts`, `translator.ts`, `listener.ts`).

- [ ] **Step 4: Commit**

```bash
git add public/src/listener.ts
git commit -m "feat: convert public/src/listener.js to TypeScript"
```

---

### Task 6: Update HTML files and verify full build

**Files:**
- Modify: `public/index.html`
- Modify: `public/translator.html`
- Modify: `public/listener.html`

**Interfaces:**
- Consumes: compiled output from Tasks 1–5
- Produces: working end-to-end build via `npm run build`

- [ ] **Step 1: Update `public/index.html`**

Change the script tag at the bottom of `<body>` from:
```html
<script src="/src/index.js"></script>
```
to:
```html
<script src="/dist/index.js"></script>
```

- [ ] **Step 2: Update `public/translator.html`**

Remove the CDN script tag and update the local script src. Replace these two lines:
```html
<script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
<script src="/src/translator.js"></script>
```
with:
```html
<script src="/dist/translator.js"></script>
```

- [ ] **Step 3: Update `public/listener.html`**

Remove the CDN script tag and update the local script src. Replace these two lines:
```html
<script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
<script src="/src/listener.js"></script>
```
with:
```html
<script src="/dist/listener.js"></script>
```

- [ ] **Step 4: Run the full production build**

```bash
npm run build
```

Expected output (approximately):
```
  dist/server/index.js  XX kb

  public/dist/index.js      X kb
  public/dist/translator.js  XX kb
  public/dist/listener.js    XX kb
```

If tsc fails: re-check `server/tsconfig.json` paths.
If esbuild fails with "Cannot resolve 'socket.io-client'": run `npm install` to ensure the package is present.

- [ ] **Step 5: Smoke test — start the server and open the app**

```bash
npm run dev
```

Then open `http://localhost:3000` in a browser. Verify:
- The landing page loads and shows "Checking status…" then "Translation not started yet"
- Navigating to `/translator.html` shows the translator dashboard
- Navigating to `/listener.html` shows the listener page
- In two browser tabs: go live on the translator tab, then connect on the listener tab — audio should stream

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/translator.html public/listener.html
git commit -m "feat: update HTML to load esbuild-compiled bundles from /dist"
```