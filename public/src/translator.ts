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
let isMuted = false;
let iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

fetch('/api/ice-servers')
  .then(r => r.json() as Promise<{ iceServers: RTCIceServer[] }>)
  .then(d => { iceServers = d.iceServers; })
  .catch(() => {});

const pinScreen      = document.getElementById('pinScreen') as HTMLElement;
const dashboard      = document.getElementById('dashboard') as HTMLElement;
const pinInput       = document.getElementById('pinInput') as HTMLInputElement;
const unlockBtn      = document.getElementById('unlockBtn') as HTMLButtonElement;
const pinError       = document.getElementById('pinError') as HTMLElement;
const goLiveBtn      = document.getElementById('goLiveBtn') as HTMLButtonElement;
const muteBtn        = document.getElementById('muteBtn') as HTMLButtonElement;
const stopBtn        = document.getElementById('stopBtn') as HTMLButtonElement;
const micSelect      = document.getElementById('micSelect') as HTMLSelectElement;
const micField       = document.getElementById('micField') as HTMLElement;
const dot            = document.getElementById('dot') as HTMLElement;
const statusMsg      = document.getElementById('statusMsg') as HTMLElement;
const listenerCountEl = document.getElementById('listenerCount') as HTMLElement;
const durationEl     = document.getElementById('durationEl') as HTMLElement;
const peersEl        = document.getElementById('peersEl') as HTMLElement;
const shareBox       = document.getElementById('shareBox') as HTMLElement;
const shareUrl       = document.getElementById('shareUrl') as HTMLElement;
const copyBtn        = document.getElementById('copyBtn') as HTMLButtonElement;
const bars           = document.querySelectorAll('.bar') as NodeListOf<HTMLElement>;

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

  socket = io(SERVER_URL);

  socket.on('connect', () => {
    socket!.emit('translator:join', { roomId: ROOM_ID, pin: pinInput.value.trim() });
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

async function verifyPin(): Promise<void> {
  const pin = pinInput.value.trim();
  if (!pin) return;

  unlockBtn.disabled = true;
  pinError.classList.add('hidden');

  try {
    const res = await fetch('/api/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json() as { ok: boolean; reason?: string };

    if (data.ok) {
      pinScreen.classList.add('hidden');
      dashboard.classList.remove('hidden');
      loadMics();
    } else if (data.reason === 'not_configured') {
      pinError.textContent = 'Translator access is not set up — contact the admin';
      pinError.classList.remove('hidden');
    } else if (data.reason === 'too_many_attempts') {
      pinError.textContent = 'Too many attempts — try again in 15 minutes';
      pinError.classList.remove('hidden');
    } else {
      pinError.textContent = 'Incorrect PIN';
      pinError.classList.remove('hidden');
    }
  } catch {
    pinError.textContent = 'Could not reach server — check your connection';
    pinError.classList.remove('hidden');
  }

  unlockBtn.disabled = false;
}

unlockBtn.addEventListener('click', verifyPin);
pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyPin(); });
