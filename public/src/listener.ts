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
