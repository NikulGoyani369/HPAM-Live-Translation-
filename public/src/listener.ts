import { io, Socket } from 'socket.io-client';

const ROOM_ID = 'hpam-english';
const SERVER_URL = window.location.origin;

let socket: Socket | null = null;
let audioEl: HTMLAudioElement | null = null;
let mediaSource: MediaSource | null = null;
let sourceBuffer: SourceBuffer | null = null;
const chunkQueue: ArrayBuffer[] = [];
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let animFrame = 0;
let startTime: number | null = null;
let timerInterval: number | null = null;

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
    const t = startTime!;
    const s = Math.floor((Date.now() - t) / 1000);
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

function startVisualizer(el: HTMLAudioElement): void {
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  const source = audioCtx.createMediaElementSource(el);
  source.connect(analyser);
  source.connect(audioCtx.destination);
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

function flushQueue(): void {
  if (!sourceBuffer || sourceBuffer.updating) return;
  if (
    sourceBuffer.buffered.length > 0 &&
    sourceBuffer.buffered.end(0) - sourceBuffer.buffered.start(0) > 30
  ) {
    sourceBuffer.remove(sourceBuffer.buffered.start(0), sourceBuffer.buffered.end(0) - 10);
    return;
  }
  if (chunkQueue.length === 0) return;
  sourceBuffer.appendBuffer(chunkQueue.shift()!);
}

function setupAudio(): void {
  mediaSource = new MediaSource();
  audioEl = new Audio();
  audioEl.src = URL.createObjectURL(mediaSource);
  audioEl.volume = Number(volumeSlider.value);

  mediaSource.addEventListener('sourceopen', () => {
    const ms = mediaSource as MediaSource;
    sourceBuffer = ms.addSourceBuffer('audio/webm;codecs=opus');
    sourceBuffer.mode = 'sequence';
    sourceBuffer.addEventListener('updateend', flushQueue);
    const el = audioEl as HTMLAudioElement;
    el.play().catch(() => {});
    startVisualizer(el);
    setStatus('Live — English translation', 'live');
    startTimer();
    waitingMsg.classList.add('hidden');
    volumeWrap.classList.remove('hidden');
    stopBtn.classList.remove('hidden');
    connectBtn.classList.add('hidden');
  });
}

function stopAudio(): void {
  sourceBuffer = null;
  chunkQueue.length = 0;
  if (mediaSource && mediaSource.readyState === 'open') mediaSource.endOfStream();
  mediaSource = null;
  if (audioEl) {
    URL.revokeObjectURL(audioEl.src);
    audioEl.pause();
    audioEl = null;
  }
  stopVisualizer();
  stopTimer();
  volumeWrap.classList.add('hidden');
}

function cleanup(): void {
  stopAudio();
  socket?.disconnect();
  socket = null;
  connectBtn.disabled = false;
}

function connect(): void {
  connectBtn.disabled = true;
  setStatus('Connecting…');

  socket = io(SERVER_URL);

  socket.on('connect', () => {
    stopAudio();
    socket!.emit('listener:join', { roomId: ROOM_ID });
  });

  socket.on('listener:joined', ({ translatorOnline }: { translatorOnline: boolean }) => {
    if (translatorOnline) {
      setStatus('Translator found — connecting…');
      setupAudio();
    } else {
      setStatus('Waiting for translator…');
      waitingMsg.classList.remove('hidden');
      connectBtn.disabled = false;
    }
  });

  socket.on('translator:online', () => {
    waitingMsg.classList.add('hidden');
    setStatus('Translator online — connecting…');
    setupAudio();
  });

  socket.on('translator:offline', () => {
    setStatus('Translator went offline');
    stopAudio();
    waitingMsg.classList.remove('hidden');
  });

  socket.on('audio:chunk', (chunk: ArrayBuffer) => {
    chunkQueue.push(chunk);
    flushQueue();
  });

  socket.on('error', ({ message }: { message: string }) => {
    setStatus('Error: ' + message, 'error');
    connectBtn.disabled = false;
  });

  socket.on('disconnect', () => {
    setStatus('Disconnected', 'error');
  });
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
