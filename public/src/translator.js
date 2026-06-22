// ── Config ──────────────────────────────────────────────────────
const ROOM_ID = 'hpam-english';
const SERVER_URL = window.location.origin;

// ── State ───────────────────────────────────────────────────────
let socket, localStream, audioCtx, analyser, animFrame;
let peers = {};
let listenerCount = 0, connectedPeers = 0;
let startTime = null, timerInterval = null;
let isLive = false, isMuted = false;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

fetch('/api/ice-servers').then(r => r.json()).then(d => { iceServers = d.iceServers; }).catch(() => {});

// ── DOM ─────────────────────────────────────────────────────────
const goLiveBtn       = document.getElementById('goLiveBtn');
const muteBtn         = document.getElementById('muteBtn');
const stopBtn         = document.getElementById('stopBtn');
const micSelect       = document.getElementById('micSelect');
const micField        = document.getElementById('micField');
const dot             = document.getElementById('dot');
const statusMsg       = document.getElementById('statusMsg');
const listenerCountEl = document.getElementById('listenerCount');
const durationEl      = document.getElementById('durationEl');
const peersEl         = document.getElementById('peersEl');
const shareBox        = document.getElementById('shareBox');
const shareUrl        = document.getElementById('shareUrl');
const copyBtn         = document.getElementById('copyBtn');
const bars            = document.querySelectorAll('.bar');

// ── Populate microphones ─────────────────────────────────────────
async function loadMics() {
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

// ── Timer ────────────────────────────────────────────────────────
function startTimer() {
  startTime = Date.now();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    durationEl.textContent = `${m}:${(s % 60).toString().padStart(2, '0')}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  durationEl.textContent = '00:00';
}

// ── Mic visualizer ───────────────────────────────────────────────
function startViz(stream) {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 32;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  animViz();
}

function animViz() {
  animFrame = requestAnimationFrame(animViz);
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  bars.forEach((bar, i) => {
    const idx = Math.floor(i * data.length / bars.length);
    const h = 4 + (data[idx] / 255) * 52;
    bar.style.height = h + 'px';
    bar.classList.toggle('active', data[idx] > 10);
  });
}

function stopViz() {
  cancelAnimationFrame(animFrame);
  if (audioCtx) audioCtx.close();
  bars.forEach(b => { b.style.height = '4px'; b.classList.remove('active'); });
}

// ── WebRTC peer for each listener ────────────────────────────────
function createPeerForListener(listenerId) {
  const pc = new RTCPeerConnection({ iceServers });

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('signal:ice', { to: listenerId, candidate });
  };

  pc.onconnectionstatechange = () => {
    if (['connected', 'completed'].includes(pc.connectionState)) {
      connectedPeers++;
    } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      connectedPeers = Math.max(0, connectedPeers - 1);
    }
    peersEl.textContent = connectedPeers;
  };

  peers[listenerId] = pc;
  return pc;
}

// ── Go Live ──────────────────────────────────────────────────────
async function goLive() {
  goLiveBtn.disabled = true;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: micSelect.value || undefined, echoCancellation: true, noiseSuppression: true }
    });
  } catch (err) {
    statusMsg.textContent = 'Microphone access denied';
    dot.className = 'dot error';
    goLiveBtn.disabled = false;
    return;
  }

  startViz(localStream);
  isLive = true;

  socket = io(SERVER_URL);

  socket.on('connect', () => {
    socket.emit('translator:join', { roomId: ROOM_ID });
  });

  socket.on('translator:joined', ({ listenerCount: lc }) => {
    listenerCount = lc;
    listenerCountEl.textContent = listenerCount;
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

  socket.on('listener:count', ({ count }) => {
    listenerCount = count;
    listenerCountEl.textContent = count;
  });

  socket.on('listener:new', async ({ listenerId }) => {
    const pc = createPeerForListener(listenerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal:offer', { to: listenerId, offer });
  });

  socket.on('signal:answer', async ({ from, answer }) => {
    await peers[from]?.setRemoteDescription(answer);
  });

  socket.on('signal:ice', ({ from, candidate }) => {
    peers[from]?.addIceCandidate(candidate).catch(() => {});
  });

  socket.on('error', ({ message }) => {
    statusMsg.textContent = message;
    dot.className = 'dot error';
  });
}

// ── Stop broadcast ───────────────────────────────────────────────
function stopBroadcast() {
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

// ── Event listeners ──────────────────────────────────────────────
goLiveBtn.addEventListener('click', goLive);
stopBtn.addEventListener('click', stopBroadcast);

muteBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  localStream.getTracks().forEach(t => t.enabled = !isMuted);
  muteBtn.textContent = isMuted ? '🎙 Unmute' : '🔇 Mute';
  muteBtn.classList.toggle('muted', isMuted);
  statusMsg.textContent = isMuted ? 'Muted — listeners cannot hear you' : 'You are live';
});

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(shareUrl.textContent).then(() => {
    copyBtn.textContent = '✅ Copied!';
    setTimeout(() => copyBtn.textContent = 'Copy Link', 2000);
  });
});
