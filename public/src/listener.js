// ── Config ──────────────────────────────────────────────────────
const ROOM_ID = 'hpam-english';
const SERVER_URL = window.location.origin;

// ── State ───────────────────────────────────────────────────────
let socket, peerConn, audioCtx, analyser, animFrame, audioEl;
let startTime = null, timerInterval = null;
let connected = false;
let translatorId = null;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

fetch('/api/ice-servers').then(r => r.json()).then(d => { iceServers = d.iceServers; }).catch(() => {});

// ── DOM ─────────────────────────────────────────────────────────
const connectBtn   = document.getElementById('connectBtn');
const stopBtn      = document.getElementById('stopBtn');
const dot          = document.getElementById('dot');
const statusMsg    = document.getElementById('statusMsg');
const durationEl   = document.getElementById('duration');
const waitingMsg   = document.getElementById('waitingMsg');
const canvas       = document.getElementById('viz');
const ctx2d        = canvas.getContext('2d');
const volumeWrap   = document.getElementById('volumeWrap');
const volumeSlider = document.getElementById('volumeSlider');
const volumePct    = document.getElementById('volumePct');

volumeSlider.addEventListener('input', () => {
  if (audioEl) audioEl.volume = volumeSlider.value;
  volumePct.textContent = Math.round(volumeSlider.value * 100) + '%';
  const pct = volumeSlider.value * 100;
  volumeSlider.style.background = `linear-gradient(to right, var(--gold) ${pct}%, rgba(255,255,255,0.1) ${pct}%)`;
});

// ── UI helpers ──────────────────────────────────────────────────
function setStatus(text, state = '') {
  statusMsg.textContent = text;
  dot.className = 'status-dot' + (state ? ' ' + state : '');
}

function startTimer() {
  startTime = Date.now();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    durationEl.textContent = `${m}:${sec}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  durationEl.textContent = '00:00';
}

// ── Visualizer ──────────────────────────────────────────────────
function startVisualizer(stream) {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  drawViz();
}

function drawViz() {
  animFrame = requestAnimationFrame(drawViz);
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

function stopVisualizer() {
  cancelAnimationFrame(animFrame);
  if (audioCtx) audioCtx.close();
  ctx2d.clearRect(0, 0, 120, 120);
}

// ── WebRTC ──────────────────────────────────────────────────────
function createPeerConn() {
  const pc = new RTCPeerConnection({ iceServers });

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && translatorId) socket.emit('signal:ice', { to: translatorId, candidate });
  };

  pc.ontrack = (e) => {
    connected = true;
    audioEl = new Audio();
    audioEl.srcObject = e.streams[0];
    audioEl.volume = volumeSlider.value;
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

// ── Connect ──────────────────────────────────────────────────────
function connect() {
  connectBtn.disabled = true;
  setStatus('Connecting…');

  socket = io(SERVER_URL);

  socket.on('connect', () => {
    socket.emit('listener:join', { roomId: ROOM_ID });
  });

  socket.on('listener:joined', ({ translatorOnline }) => {
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

  socket.on('signal:offer', async ({ from, offer }) => {
    translatorId = from;
    if (!peerConn) peerConn = createPeerConn();
    await peerConn.setRemoteDescription(offer);
    const answer = await peerConn.createAnswer();
    await peerConn.setLocalDescription(answer);
    socket.emit('signal:answer', { to: from, answer });
  });

  socket.on('signal:ice', ({ candidate }) => {
    peerConn?.addIceCandidate(candidate).catch(() => {});
  });

  socket.on('error', ({ message }) => {
    setStatus('Error: ' + message, 'error');
    connectBtn.disabled = false;
  });

  socket.on('disconnect', () => {
    if (connected) setStatus('Disconnected', 'error');
  });
}

function cleanup() {
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

// ── Buttons ──────────────────────────────────────────────────────
connectBtn.addEventListener('click', connect);
stopBtn.addEventListener('click', () => {
  cleanup();
  setStatus('Stopped');
  stopBtn.classList.add('hidden');
  connectBtn.classList.remove('hidden');
  connectBtn.textContent = '🎧 Start Listening';
  waitingMsg.classList.add('hidden');
});
