/* ═══════════════════════════════════════════
   DubForge Studio — Mobile App Logic
═══════════════════════════════════════════ */

'use strict';

// ── Audio Context ──────────────────────────
let ctx = null;
let micStream = null;
let micSource = null;
let analyserNode = null;
let gainNode = null;
let lowShelf = null;
let midPeak = null;
let highShelf = null;
let convolver = null;
let dryGain = null;
let wetGain = null;
let masterGainNode = null;
let monitorGain = null;     // monitor gate — default MUTED (prevents echo)
let compressorNode = null;  // dynamics compressor for pro vocal levels
let recDest = null;         // media stream destination to record processed audio
let deEsserFilter = null;   // lowpass filter at 6.5kHz to dampen mouth clicks/breath hiss
let highPassFilter = null;  // steep low cut below 75Hz to remove rumble
let gateGain = null;        // native gain node for noise gate
let recBuffers = [];        // holds Float32Array chunks for WAV encoding
let recLength = 0;         // total sample length
let recorderNode = null;    // ScriptProcessorNode to capture raw PCM output

// ── State ──────────────────────────────────
let isRecording = false;
let isPlaying = false;
let mediaRecorder = null;
let recordedChunks = [];
let takes = [];
let playhead = 0;
let playTimer = null;
let playStartTime = 0;
let animFrame = null;
let currentActiveTake = null;   // AudioBufferSourceNode for take playback

// ── DOM ────────────────────────────────────
const statusPill    = document.getElementById('statusPill');
const timeDisplay   = document.getElementById('timeDisplay');
const waveCanvas    = document.getElementById('waveCanvas');
const waveCtx       = waveCanvas.getContext('2d');
const btnRecord     = document.getElementById('btnRecord');
const btnPlayPause  = document.getElementById('btnPlayPause');
const btnStop       = document.getElementById('btnStop');
const btnRewind     = document.getElementById('btnRewind');

const iconPlay      = document.getElementById('iconPlay');
const iconPause     = document.getElementById('iconPause');
const takeList      = document.getElementById('takeList');

// ── Init Audio Chain ──────────────────────
async function initAudio() {
  if (ctx) return true;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    if (ctx.state === 'suspended') await ctx.resume();

    // --- nodes ---
    gainNode       = ctx.createGain();            // input gain
    lowShelf       = ctx.createBiquadFilter();
    midPeak        = ctx.createBiquadFilter();
    highShelf      = ctx.createBiquadFilter();
    convolver      = ctx.createConvolver();
    dryGain        = ctx.createGain();
    wetGain        = ctx.createGain();
    masterGainNode = ctx.createGain();
    analyserNode   = ctx.createAnalyser();
    monitorGain    = ctx.createGain();            // monitor: default MUTED
    monitorGain.gain.value = 0;                  // ← no echo by default
    compressorNode = ctx.createDynamicsCompressor(); // pro vocal levels
    recDest        = ctx.createMediaStreamDestination(); // for processed recordings
    deEsserFilter  = ctx.createBiquadFilter();    // high-frequency mouth click/breath filter
    highPassFilter = ctx.createBiquadFilter();    // steep low cut below 75Hz for rumble/breaths
    gateGain = ctx.createGain();
    gateGain.gain.value = 1.0;

    // --- EQ config ---
    highPassFilter.type = 'highpass'; highPassFilter.frequency.value = 50; // transparent sub-bass cut, preserves full vocal warmth
    lowShelf.type = 'lowshelf';   lowShelf.frequency.value  = 120; // warm natural low end
    deEsserFilter.type = 'lowpass'; deEsserFilter.frequency.value = 20000; // completely open natural high-end
    midPeak.type  = 'peaking';    midPeak.frequency.value   = 2800; midPeak.Q.value = 0.8;
    highShelf.type= 'highshelf';  highShelf.frequency.value = 9000;

    // --- analyser ---
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.75;

    // --- chain ---
    // mic -> gain -> highPass -> lowShelf -> deEsser -> compressor -> gateGain -> midPeak -> highShelf -> dry/wet reverb -> master
    gainNode.connect(highPassFilter);
    highPassFilter.connect(lowShelf);
    lowShelf.connect(deEsserFilter);
    deEsserFilter.connect(compressorNode);
    compressorNode.connect(gateGain);
    gateGain.connect(midPeak);
    midPeak.connect(highShelf);

    // analyser tapped before gate for true level detection and gate control
    compressorNode.connect(analyserNode);

    // reverb / dry-wet path
    highShelf.connect(dryGain);
    highShelf.connect(convolver);
    convolver.connect(wetGain);
    dryGain.connect(masterGainNode);
    wetGain.connect(masterGainNode);

    // output to speaker (monitored) and recorder
    masterGainNode.connect(monitorGain);
    monitorGain.connect(ctx.destination);
    masterGainNode.connect(recDest);

    // Apply default effect preset values
    applyActiveEffects();

    return true;
  } catch (e) {
    alert('Audio init failed: ' + e.message);
    return false;
  }
}

function applyActiveEffects() {
  if (!ctx) return;

  // 1. Read EQ values from sliders
  lowShelf.gain.value = parseFloat(document.getElementById('eqLow').value);
  midPeak.gain.value = parseFloat(document.getElementById('eqMid').value);
  highShelf.gain.value = parseFloat(document.getElementById('eqHigh').value);

  // 2. Vocal Dynamic Compressor - subtle and transparent for natural voice
  compressorNode.threshold.value = -18; // dB
  compressorNode.knee.value = 25;       // soft knee for natural dynamics
  compressorNode.ratio.value = 1.4;     // gentle, transparent compression
  compressorNode.attack.value = 0.020;   // attack (20ms)
  compressorNode.release.value = 0.150;  // smooth release (150ms)

  // 3. Read Reverb values from sliders
  const size = parseFloat(document.getElementById('reverbSize').value);
  const wet = parseFloat(document.getElementById('reverbWet').value);
  buildReverbImpulse(size / 100 * 3 + 0.1, 0.5);
  const isReverb = document.getElementById('reverbToggle').checked;
  wetGain.gain.value = isReverb ? wet / 100 : 0;
  dryGain.gain.value = isReverb ? (1 - wet / 150) : 1.0;

  // 4. Apply input gain and master volume on initial load
  const inpGain = parseFloat(document.getElementById('inputGain').value);
  if (gainNode) gainNode.gain.value = inpGain / 100;

  const mVol = parseFloat(document.getElementById('masterVol').value);
  if (masterGainNode) masterGainNode.gain.value = mVol / 100;
}

function buildReverbImpulse(duration, decay) {
  if (!ctx) return;
  const rate     = ctx.sampleRate;
  const length   = rate * duration;
  const impulse  = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  convolver.buffer = impulse;
}

async function getMic() {
  if (!micStreamActive) return false;
  if (micStream) return true;
  
  const deviceId = document.getElementById('inputDevice').value;
  // Use natural mic settings without aggressive browser suppression
  const constraints = {
    audio: deviceId && deviceId !== 'default'
      ? {
          deviceId: { exact: deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      : {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
  };

  try {
    micStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    console.warn("Retrying getUserMedia with standard constraints due to error:", e);
    try {
      const fallbackConstraints = {
        audio: deviceId && deviceId !== 'default'
          ? { deviceId: { exact: deviceId } }
          : true
      };
      micStream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
    } catch (fallbackErr) {
      alert('Mic access denied: ' + fallbackErr.message);
      return false;
    }
  }

  try {
    micSource = ctx.createMediaStreamSource(micStream);
    micSource.connect(gainNode);
    return true;
  } catch (e) {
    alert('Audio connection failed: ' + e.message);
    return false;
  }
}

// ── Waveform + Meter Draw ─────────────────
function drawLoop() {
  animFrame = requestAnimationFrame(drawLoop);

  // resize canvas
  const rect = waveCanvas.getBoundingClientRect();
  if (waveCanvas.width !== rect.width * devicePixelRatio) {
    waveCanvas.width  = rect.width  * devicePixelRatio;
    waveCanvas.height = rect.height * devicePixelRatio;
    waveCtx.scale(devicePixelRatio, devicePixelRatio);
  }
  const W = rect.width, H = rect.height;

  // Transparent background for header
  waveCtx.clearRect(0, 0, W, H);

  if (!analyserNode) {
    drawIdleWave(W, H);
    return;
  }

  const buf = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(buf); // get frequency data for spectrum bars

  // 1. Calculate Peak (RMS) for VU meters
  let rms = 0;
  const timeBuf = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteTimeDomainData(timeBuf);
  for (let i = 0; i < timeBuf.length; i++) {
    rms += Math.pow((timeBuf[i] / 128 - 1), 2);
  }
  rms = Math.sqrt(rms / timeBuf.length);

  // 1b. Soft transparent noise gate
  const isGateEnabled = document.getElementById('gateToggle').checked;
  const thresholdDb = parseFloat(document.getElementById('gateThresh').value);
  const threshold = Math.pow(10, thresholdDb / 20);
  
  if (gateGain) {
    if (isGateEnabled) {
      if (rms < threshold) {
        gateGain.gain.setTargetAtTime(0.4, ctx.currentTime, 0.080);
      } else {
        gateGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.010);
      }
    } else {
      gateGain.gain.value = 1.0;
    }
  }

  // 2. Draw Sleek Frequency Waves in Header Background
  const barCount = Math.floor(W / 14);
  const barWidth = 6;
  const barGap = (W - (barCount * barWidth)) / barCount;

  const grad = waveCtx.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, 'rgba(56, 189, 248, 0.45)');   // Cyan
  grad.addColorStop(0.5, 'rgba(168, 85, 247, 0.55)'); // Purple
  grad.addColorStop(1, 'rgba(239, 68, 68, 0.65)');    // Vibrant Red/Pink

  waveCtx.fillStyle = grad;

  for (let i = 0; i < barCount; i++) {
    const binIndex = Math.floor((i / barCount) * (buf.length * 0.6));
    const val = buf[binIndex] || 0;
    const barHeight = Math.max(3, (val / 255) * H * 0.85);

    const x = i * (barWidth + barGap);
    const y = H - barHeight;

    waveCtx.beginPath();
    if (waveCtx.roundRect) {
      waveCtx.roundRect(x, y, barWidth, barHeight, [3, 3, 0, 0]);
    } else {
      waveCtx.rect(x, y, barWidth, barHeight);
    }
    waveCtx.fill();
  }
}

function drawIdleWave(W, H) {
  waveCtx.beginPath();
  waveCtx.strokeStyle = 'rgba(168, 85, 247, 0.28)';
  waveCtx.lineWidth = 2.5;
  const t = Date.now() * 0.002;
  for (let i = 0; i < W; i += 2) {
    const y = H * 0.55 + Math.sin(i * 0.025 + t) * (H * 0.22) + Math.cos(i * 0.01 - t) * 4;
    i === 0 ? waveCtx.moveTo(i, y) : waveCtx.lineTo(i, y);
  }
  waveCtx.stroke();
}

// ── Time Format ───────────────────────────
function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2,'0')}:${sec}`;
}

// ── Record ────────────────────────────────
btnRecord.addEventListener('click', async () => {
  if (isRecording) {
    stopRecording();
  } else {
    if (!(await initAudio())) return;
    if (!(await getMic())) return;
    startRecording();
  }
});

function startRecording() {
  recordedChunks = [];
  recBuffers = [];
  recLength = 0;

  // Set up ScriptProcessor to capture raw PCM from AudioContext output
  recorderNode = ctx.createScriptProcessor(4096, 1, 1);
  recorderNode.onaudioprocess = e => {
    if (!isRecording) return;
    const input = e.inputBuffer.getChannelData(0);
    recBuffers.push(new Float32Array(input));
    recLength += input.length;
  };

  // Connect recorderNode to master output
  masterGainNode.connect(recorderNode);
  
  // Dummy gain node with 0 volume to force processing without double audio path
  const dummyGain = ctx.createGain();
  dummyGain.gain.value = 0;
  recorderNode.connect(dummyGain);
  dummyGain.connect(ctx.destination);

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  // record processed studio stream via AudioContext
  mediaRecorder = new MediaRecorder(recDest.stream, { mimeType, audioBitsPerSecond: 320000 });
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = saveTake;
  mediaRecorder.start(100);

  isRecording = true;
  playhead = 0;
  playStartTime = Date.now();
  updateTimer();
  btnRecord.classList.add('active');
  setStatus('● Recording', 'recording');
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  mediaRecorder.stop();
  isRecording = false;
  clearInterval(playTimer);
  btnRecord.classList.remove('active');
  setStatus('● Ready');
}

function updateTimer() {
  clearInterval(playTimer);
  playTimer = setInterval(() => {
    const elapsed = (Date.now() - playStartTime) / 1000;
    timeDisplay.textContent = fmtTime(elapsed);
  }, 100);
}

// ── Save Take ─────────────────────────────
function saveTake() {
  if (recorderNode) {
    recorderNode.disconnect();
    recorderNode = null;
  }

  // Determine export format
  const fmt = document.getElementById('exportFormat').value || 'wav';
  let finalBlob;

  if (fmt === 'wav') {
    const merged = mergeBuffers(recBuffers, recLength);
    finalBlob = encodeWAV(merged, ctx.sampleRate);
  } else {
    finalBlob = new Blob(recordedChunks, { type: 'audio/webm' });
  }

  const dur = ((Date.now() - playStartTime) / 1000).toFixed(1);
  const takeNum = takes.length + 1;
  const take = {
    id: takeNum,
    name: `Take ${takeNum}`,
    blob: finalBlob,
    duration: parseFloat(dur),
    videoUrl: null,
    isMerging: true
  };
  takes.push(take);
  renderTakes();
  autoMergeTake(take);
}

async function autoMergeTake(take) {
  try {
    const videoEl = document.getElementById('dubVideo');
    const videoFile = videoEl.dataset.filename || 'vid.mp4';

    const response = await fetch('/merge', {
      method: 'POST',
      headers: {
        'X-Video-File': videoFile,
        'Content-Type': 'audio/wav'
      },
      body: take.blob
    });

    const result = await response.json();
    if (result.ok && result.merged_video_url) {
      take.videoUrl = result.merged_video_url;
      take.isMerging = false;

      // Update the main top video player so user can play it directly in dashboard too
      const topVideo = document.getElementById('dubVideo');
      if (topVideo) {
        topVideo.src = result.merged_video_url;
        topVideo.muted = false;
      }
      renderTakes();
    } else {
      take.isMerging = false;
      renderTakes();
    }
  } catch (err) {
    console.error("Auto merge error:", err);
    take.isMerging = false;
    renderTakes();
  }
}

function mergeBuffers(recBuffers, recLength) {
  const result = new Float32Array(recLength);
  let offset = 0;
  for (let i = 0; i < recBuffers.length; i++) {
    result.set(recBuffers[i], offset);
    offset += recBuffers[i].length;
  }
  return result;
}

function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate * channelCount * bytesPerSample)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // 16-bit
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  floatTo16BitPCM(view, 44, samples);

  return new Blob([view], { type: 'audio/wav' });
}

function floatTo16BitPCM(output, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function renderTakes() {
  if (!takes.length) {
    takeList.innerHTML = '<div class="empty-state">No takes yet — hit ⏺ to record!</div>';
    return;
  }

  takeList.innerHTML = takes.map(t => `
    <div class="take-card" id="take-${t.id}" style="padding:14px; margin-bottom:12px;">
      <div class="take-top" style="display:flex; justify-content:space-between; align-items:center;">
        <span class="take-name" style="font-weight:600; font-size:15px; color:#f8fafc;">🎬 ${t.name} (Dubbed Video)</span>
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="take-dur" style="font-size:12px; color:var(--muted);">${fmtTime(t.duration)}</span>
          <button class="take-del" data-id="${t.id}" title="Delete" style="background:none; border:none; color:var(--muted); cursor:pointer; font-size:16px;">✕</button>
        </div>
      </div>

      ${t.videoUrl ? `
        <div class="take-video-wrap" style="position:relative; width:100%; border-radius:8px; overflow:hidden; background:#000; margin-top:10px;">
          <video class="take-video-player" id="vid-${t.id}" controls playsinline style="width:100%; max-height:220px; display:block; border-radius:8px;" src="${t.videoUrl}"></video>
        </div>
        <div class="take-actions" style="margin-top:10px; display:flex; gap:8px;">
          <a href="${t.videoUrl}" download="Dubbed_${t.name.replace(/\s+/g, '_')}.mp4" class="btn-primary" style="flex:1; text-align:center; text-decoration:none; padding:8px 12px; font-size:13px; border-radius:6px; display:flex; align-items:center; justify-content:center; gap:6px; background:linear-gradient(135deg, #a855f7 0%, #7c3aed 100%); color:white;">
            ⬇ Download Dubbed Video
          </a>
          <button class="take-dl" data-id="${t.id}" style="width:auto; padding:8px 12px; font-size:12px; opacity:0.85; background:rgba(255,255,255,0.08); border:1px solid var(--border); color:white; border-radius:6px; cursor:pointer;">
            🎙️ Audio
          </button>
        </div>
      ` : `
        <div style="padding:22px; text-align:center; color:#a855f7; font-size:13px; display:flex; align-items:center; justify-content:center; gap:10px; background:rgba(168,85,247,0.07); border:1px dashed rgba(168,85,247,0.3); border-radius:8px; margin-top:10px;">
          <span class="rec-dot" style="display:inline-block; width:8px; height:8px; background:#a855f7; border-radius:50%; animation:pulse 1s infinite;"></span>
          Dubbing onto video... video taiyaar ho rahi hai...
        </div>
      `}
    </div>
  `).join('');

  // download audio buttons
  takeList.querySelectorAll('.take-dl').forEach(b =>
    b.addEventListener('click', () => downloadTake(parseInt(b.dataset.id))));

  // delete buttons
  takeList.querySelectorAll('.take-del').forEach(b =>
    b.addEventListener('click', () => deleteTake(parseInt(b.dataset.id))));
}

function downloadTake(id) {
  const take = takes.find(t => t.id === id);
  if (!take) return;
  const isWav = take.blob.type === 'audio/wav';
  const fmt = isWav ? 'wav' : 'webm';
  const url = URL.createObjectURL(take.blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = `DubForge_${take.name.replace(' ', '_')}.${fmt}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function deleteTake(id) {
  takes = takes.filter(t => t.id !== id);
  renderTakes();
}

// ── Play/Stop Transport ───────────────────
btnPlayPause.addEventListener('click', async () => {
  if (!(await initAudio())) return;
  if (isPlaying) {
    pausePlayback();
  } else {
    resumePlayback();
  }
});

btnStop.addEventListener('click', () => {
  stopPlayback();
  playhead = 0;
  timeDisplay.textContent = '00:00.0';
  const video = document.getElementById('dubVideo');
  if (video) video.currentTime = 0;
});

btnRewind.addEventListener('click', () => {
  stopPlayback();
  playhead = 0;
  timeDisplay.textContent = '00:00.0';
  const video = document.getElementById('dubVideo');
  if (video) video.currentTime = 0;
});

function resumePlayback() {
  isPlaying = true;
  playStartTime = Date.now() - playhead * 1000;
  iconPlay.style.display  = 'none';
  iconPause.style.display = '';
  setStatus('▶ Playing');
  updateTimer();
  
  const video = document.getElementById('dubVideo');
  if (video) {
    video.currentTime = playhead;
    video.muted = false;
    video.play().catch(() => {});
  }
}
function pausePlayback() {
  isPlaying = false;
  clearInterval(playTimer);
  iconPlay.style.display  = '';
  iconPause.style.display = 'none';
  setStatus('● Ready');
  
  const video = document.getElementById('dubVideo');
  if (video) video.pause();
}
function stopPlayback() {
  isPlaying = false;
  clearInterval(playTimer);
  iconPlay.style.display  = '';
  iconPause.style.display = 'none';
  setStatus('● Ready');
  
  const video = document.getElementById('dubVideo');
  if (video) video.pause();
}

// ── Status ────────────────────────────────
function setStatus(text, cls = '') {
  statusPill.textContent = text;
  statusPill.className = 'status-pill' + (cls ? ' ' + cls : '');
}

// ── Tabs ──────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

// ── Settings Modal ────────────────────────
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('settingsModal').style.display = 'flex';
});
document.getElementById('closeSettings').addEventListener('click', () => {
  document.getElementById('settingsModal').style.display = 'none';
});
document.getElementById('saveSettings').addEventListener('click', () => {
  document.getElementById('settingsModal').style.display = 'none';
});
document.getElementById('settingsModal').addEventListener('click', e => {
  if (e.target === document.getElementById('settingsModal'))
    document.getElementById('settingsModal').style.display = 'none';
});

// ── EQ Controls ───────────────────────────
function bindRange(id, valId, unit, transform, apply) {
  const el  = document.getElementById(id);
  const val = document.getElementById(valId);
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    val.textContent = transform(v) + unit;
    if (apply) apply(v);
  });
}


bindRange('eqLow',  'eqLowVal',  'dB', v => (v > 0 ? '+' : '') + v, () => { applyActiveEffects(); });
bindRange('eqMid',  'eqMidVal',  'dB', v => (v > 0 ? '+' : '') + v, () => { applyActiveEffects(); });
bindRange('eqHigh', 'eqHighVal', 'dB', v => (v > 0 ? '+' : '') + v, () => { applyActiveEffects(); });

bindRange('reverbSize', 'reverbSizeVal', '%', v => v, () => { applyActiveEffects(); });
bindRange('reverbWet', 'reverbWetVal', '%', v => v, () => { applyActiveEffects(); });
document.getElementById('reverbToggle').addEventListener('change', () => { applyActiveEffects(); });

bindRange('gateThresh', 'gateThreshVal', 'dB', v => v, () => {});
document.getElementById('gateToggle').addEventListener('change', () => {});

bindRange('pitchShift', 'pitchShiftVal', ' st', v => (v > 0 ? '+' : '') + v, () => {});

bindRange('inputGain', 'inputGainVal', '%', v => v, v => {
  if (gainNode) gainNode.gain.value = v / 100;
});

// Master volume — convert 0-150 → dB approx
const masterVolSlider = document.getElementById('masterVol');
const masterVolVal    = document.getElementById('masterVolVal');
masterVolSlider.addEventListener('input', () => {
  const v = parseFloat(masterVolSlider.value);
  const db = v === 0 ? '-∞' : ((20 * Math.log10(v / 100)).toFixed(1));
  masterVolVal.textContent = (db === '-∞' ? '-∞' : (parseFloat(db) > 0 ? '+' + db : db)) + 'dB';
  if (masterGainNode) masterGainNode.gain.value = v / 100;
});

// Monitor toggle — controls monitorGain so no echo when OFF
document.getElementById('monitorToggle').addEventListener('change', async e => {
  if (e.target.checked) {
    if (!(await initAudio())) return;
    if (!(await getMic())) return;
    monitorGain.gain.value = 1.0;   // enable speaker output
    setStatus('👂 Monitoring');
  } else {
    if (monitorGain) monitorGain.gain.value = 0; // mute → no echo
    setStatus('● Ready');
  }
});

// ── Mic Device Enum ───────────────────────
async function enumDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const sel = document.getElementById('inputDevice');
    sel.innerHTML = '';
    devices.filter(d => d.kind === 'audioinput').forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      sel.appendChild(opt);
    });
    if (!sel.options.length) {
      const opt = document.createElement('option');
      opt.value = 'default'; opt.textContent = 'Default Microphone';
      sel.appendChild(opt);
    }
  } catch (_) {}
}

navigator.mediaDevices.getUserMedia({ audio: true })
  .then(() => enumDevices())
  .catch(() => {
    const sel = document.getElementById('inputDevice');
    sel.innerHTML = '<option value="default">Default Microphone</option>';
  });

// ── Default Script ────────────────────────
const DEFAULT_SCRIPT = `🎬 DUBBING SCRIPT — Fullmetal Alchemist (Hindi)
════════════════════════════════

[00:00 - 00:06.5] [SLOW / DHEEMA]
🎬 [Intro: Animation & Sound Effects] — Dubbing 6.5s par shuru hogi
(Pehle animation chalega, 6.5s ke baad pehli line bolna)

[00:06.5 - 00:12.0] [SERIOUS / REFLECTIVE]
Aisi koi seekh nahi hoti jisme dard na ho... aisi koi cheez wajood hi nahi rakhti.

[00:12.0 - 00:17.5] [MATURE / DEEP]
Qurbani dena zaroori hai... aap kuch pa nahi sakte, bina pehle kuch khoye.

[00:17.5 - 00:26.5] [INTENSE / EMOTIONAL]
Lekin... agar aap us dard ko bardasht kar sakein aur usse aage badh sakein, toh aap payenge ki ab aapke paas ek aisa dil hai jo kisi bhi rukawat ko paar kar sake...

[00:26.5 - 00:30.5] [POWERFUL / RESOLUTE]
Haan... ek aisa dil, jo Fullmetal ban chuka ho.

════════════════════════════════
TIPS:
• 00:00 - 00:06.5s — Animation & SFX intro (dialogue ka intezar karein)
• 00:06.5s — Edward Elric bolna shuru karta hai (Painless lesson)
• 00:17.5s — Pocket watch shot ("Although...")
• 00:26.5s — Fullmetal heart ending
• Line par tap karke video ko direct us dialogue par seek kar sakte hain!`;

document.getElementById('dubScript').value = DEFAULT_SCRIPT;

// ── Teleprompter ──────────────────────────
const EMOTIONS = [
  { id: 'neutral', icon: '😐', label: '😐 Neutral / Normal', cls: 'emo-neutral' },
  { id: 'gentle', icon: '🌸', label: '🌸 Gentle / Innocent', cls: 'emo-gentle' },
  { id: 'mature', icon: '💀', label: '💀 Mature / Deep', cls: 'emo-mature' },
  { id: 'slow', icon: '🐌', label: '🐌 Slow / Dheema', cls: 'emo-slow' },
  { id: 'serious', icon: '🎭', label: '🎭 Serious / Dark', cls: 'emo-serious' },
  { id: 'intense', icon: '🔥', label: '🔥 Intense', cls: 'emo-intense' }
];

let tpLines = [];
let tpEmotions = []; // Stores emotion ID for each line index
let tpTimings = [];  // Stores { start: number, end: number } for each line
let tpIndex = 0;
let tpTimer = null;
let tpEditing = false;

const tpView    = document.getElementById('teleprompterView');
const tpContent = document.getElementById('teleprompterContent');
const dubScript = document.getElementById('dubScript');
const editBtn   = document.getElementById('editScriptBtn');
const autoScroll = document.getElementById('autoScrollToggle');

function parseTimeStr(s) {
  if (!s) return null;
  const parts = s.trim().split(':');
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  const val = parseFloat(s);
  return isNaN(val) ? null : val;
}

function parseTimeTag(str) {
  const match = str.match(/\[(\d+:\d+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:-\s*(\d+:\d+(?:\.\d+)?|\d+(?:\.\d+)?))?\]/);
  if (!match) return null;
  const start = parseTimeStr(match[1]);
  const end = match[2] ? parseTimeStr(match[2]) : null;
  if (start === null) return null;
  return { start, end };
}

function getLineDuration(i) {
  const t = tpTimings[i];
  if (!t || typeof t.start !== 'number') return null;
  if (typeof t.end === 'number') {
    return Math.max(0, t.end - t.start);
  }
  for (let j = i + 1; j < tpTimings.length; j++) {
    if (tpTimings[j] && typeof tpTimings[j].start === 'number') {
      return Math.max(0, tpTimings[j].start - t.start);
    }
  }
  return null;
}

function buildTeleprompter() {
  const text = dubScript.value || DEFAULT_SCRIPT;
  const rawLines = text.split('\n');
  
  tpLines = [];
  tpEmotions = [];
  tpTimings = [];
  
  let currentEmotion = 'neutral';
  let currentTiming = null;
  
  rawLines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    
    // Filter out metadata headers, divider lines, and tips
    if (trimmed.startsWith('🎬 DUBBING') || trimmed.startsWith('════') || trimmed.startsWith('TIPS') || trimmed.startsWith('•')) return;
    
    // Parse timestamp cue if present, e.g. [00:06.5 - 00:12.0]
    const timeMatch = parseTimeTag(trimmed);
    if (timeMatch) {
      currentTiming = timeMatch;
    }

    // Parse emotion cues e.g. [GENTLE / INNOCENT TONE]
    if (trimmed.startsWith('[')) {
      const lower = trimmed.toLowerCase();
      if (lower.includes('gentle') || lower.includes('innocent') || lower.includes('narmi')) {
        currentEmotion = 'gentle';
      } else if (lower.includes('mature') || lower.includes('deep') || lower.includes('gehra')) {
        currentEmotion = 'mature';
      } else if (lower.includes('slow') || lower.includes('dheema') || lower.includes('dheeme')) {
        currentEmotion = 'slow';
      } else if (lower.includes('serious') || lower.includes('dark') || lower.includes('reflective')) {
        currentEmotion = 'serious';
      } else if (lower.includes('intense') || lower.includes('drama') || lower.includes('emotional') || lower.includes('powerful') || lower.includes('resolute')) {
        currentEmotion = 'intense';
      }
      
      // If the line consists only of bracket tags [tag1] [tag2], skip adding as dialogue text
      if (trimmed.replace(/\[[^\]]*\]/g, '').trim() === '') {
        return;
      }
    }
    
    // Parse pause instructions e.g. (Choti si saans)
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      return;
    }
    
    tpLines.push(trimmed.replace(/\[\d+:\d+(?:\.\d+)?(?:\s*-\s*\d+:\d+(?:\.\d+)?)?\]\s*/g, ''));
    tpEmotions.push(currentEmotion);
    tpTimings.push(currentTiming ? { ...currentTiming } : null);
    currentEmotion = 'neutral';
    currentTiming = null;
  });

  renderTeleprompterLines();
  activateLine(0);
}

function renderTeleprompterLines() {
  const railHtml = `
    <div class="tp-ticker-rail" id="tpTickerRail" title="Click or drag to seek timeline">
      <div class="tp-ticker-fill" id="tpTickerFill"></div>
      <div class="tp-ticker-head" id="tpTickerHead">
        <div class="tp-ticker-dot"></div>
        <div class="tp-ticker-pointer"></div>
        <span class="tp-ticker-time" id="tpTickerTime">0.0s</span>
      </div>
    </div>
  `;

  const linesHtml = tpLines.map((line, i) => {
    const emotionId = tpEmotions[i] || 'neutral';
    const emotion = EMOTIONS.find(e => e.id === emotionId) || EMOTIONS[0];
    const timing = tpTimings[i];
    const durSec = getLineDuration(i);
    
    const durText = durSec !== null ? `${durSec.toFixed(1)}s` : (timing && typeof timing.start === 'number' ? `${timing.start.toFixed(1)}s` : '');
    
    let textStyle = '';
    if (emotionId === 'gentle') {
      textStyle = "font-family: 'Georgia', 'Times New Roman', serif; color: #4ade80; font-style: italic; font-weight: 400;";
    } else if (emotionId === 'mature') {
      textStyle = "font-family: 'Impact', 'Arial Black', sans-serif; color: #c084fc; font-weight: bold; letter-spacing: 0.05em;";
    } else if (emotionId === 'slow') {
      textStyle = "font-family: 'Courier New', 'Courier', monospace; color: #facc15; font-weight: bold; letter-spacing: 0.08em;";
    } else if (emotionId === 'serious') {
      textStyle = "font-family: 'Times New Roman', 'Georgia', serif; color: #38bdf8; font-weight: bold; text-decoration: underline; text-decoration-color: rgba(56,189,248,0.3);";
    } else if (emotionId === 'intense') {
      textStyle = "font-family: 'Impact', 'Arial Black', sans-serif; color: #f87171; font-size: 19px; text-shadow: 0 0 8px rgba(239,68,68,0.25);";
    } else {
      textStyle = "font-family: 'Inter', 'system-ui', sans-serif; color: rgba(255,255,255,0.85); font-weight: 500;";
    }
    
    const pickerHtml = `
      <div class="tp-picker-popover" id="picker-${i}" style="display:none">
        ${EMOTIONS.map(e => `<button class="picker-opt ${e.cls}" data-i="${i}" data-val="${e.id}">${e.label}</button>`).join('')}
      </div>
    `;
    
    return `
      <div class="tp-line-container" data-i="${i}">
        <div class="tp-line-wrap">
          <div class="tp-line-meta" data-i="${i}" title="Tap to change emotion (${emotion.id})">
            <span class="tp-emotion-icon">${emotion.icon}</span>
            ${durText ? `<span class="tp-line-duration">${durText}</span>` : ''}
          </div>
          <div class="tp-line tp-dialog" data-i="${i}" style="${textStyle}">${escapeHtml(line)}</div>
        </div>
        ${pickerHtml}
      </div>
    `;
  }).join('');

  tpContent.innerHTML = railHtml + linesHtml;
  requestAnimationFrame(() => {
    updateCuePoints();
    initRailEvents();
    const vid = document.getElementById('dubVideo');
    updateTicker(vid ? vid.currentTime : 0);
  });
}

function updateCuePoints() {
  const rail = document.getElementById('tpTickerRail');
  if (!rail) return;
  rail.querySelectorAll('.tp-rail-cue').forEach(el => el.remove());
  
  const containers = tpContent.querySelectorAll('.tp-line-container');
  if (!containers.length) return;

  const lastContainer = containers[containers.length - 1];
  const railTotalHeight = lastContainer.offsetTop + lastContainer.offsetHeight;
  rail.style.height = `${railTotalHeight}px`;

  containers.forEach((c, i) => {
    const cue = document.createElement('div');
    cue.className = 'tp-rail-cue';
    cue.style.top = c.offsetTop + 'px';
    cue.dataset.i = i;
    cue.title = `Line ${i + 1}`;
    rail.appendChild(cue);
  });
}

function initRailEvents() {
  const rail = document.getElementById('tpTickerRail');
  if (!rail || rail.dataset.bound) return;
  rail.dataset.bound = 'true';

  function handleRailSeek(e) {
    const rect = rail.getBoundingClientRect();
    const clickY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    const targetTime = getTimeFromTickerY(clickY);
    const video = document.getElementById('dubVideo');
    if (video) {
      video.currentTime = targetTime;
    }
    updateTicker(targetTime);
  }

  rail.addEventListener('pointerdown', e => {
    e.stopPropagation();
    handleRailSeek(e);
    const onMove = ev => handleRailSeek(ev);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function cycleEmotion(idx) {
  togglePicker(idx);
}

function togglePicker(idx) {
  tpContent.querySelectorAll('.tp-picker-popover').forEach((p, i) => {
    if (i !== idx) p.style.display = 'none';
  });
  
  const picker = document.getElementById('picker-' + idx);
  if (picker) {
    picker.style.display = picker.style.display === 'none' ? 'flex' : 'none';
  }
}

function setLineEmotion(idx, emotionId) {
  tpEmotions[idx] = emotionId;
  renderTeleprompterLines();
  activateLine(tpIndex);
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function getResolvedTimings() {
  const N = tpLines.length;
  const vid = document.getElementById('dubVideo');
  const totalDur = (vid && vid.duration && !isNaN(vid.duration) && vid.duration > 0) ? vid.duration : 30.5;
  const timings = [];

  for (let i = 0; i < N; i++) {
    const raw = tpTimings[i];
    let start = raw && typeof raw.start === 'number' ? raw.start : null;
    let end = raw && typeof raw.end === 'number' ? raw.end : null;
    timings.push({ start, end });
  }

  for (let i = 0; i < N; i++) {
    if (timings[i].start === null) {
      if (i === 0) {
        timings[i].start = 0;
      } else {
        const prevEnd = timings[i - 1].end !== null ? timings[i - 1].end : timings[i - 1].start;
        timings[i].start = prevEnd !== null ? prevEnd : (i * (totalDur / N));
      }
    }
  }

  for (let i = 0; i < N; i++) {
    if (timings[i].end === null) {
      if (i + 1 < N && timings[i + 1].start !== null) {
        timings[i].end = timings[i + 1].start;
      } else {
        timings[i].end = totalDur;
      }
    }
    if (timings[i].end < timings[i].start) {
      timings[i].end = timings[i].start + 1.0;
    }
  }
  return { timings, totalDur };
}

function getTickerY(t) {
  const containers = tpContent.querySelectorAll('.tp-line-container');
  if (!containers.length) return 0;
  const { timings } = getResolvedTimings();
  const N = containers.length;

  const firstTop = containers[0].offsetTop;
  const firstStart = timings[0] ? timings[0].start : 0;

  if (t <= 0) return firstTop;
  if (firstStart > 0 && t < firstStart) {
    return (t / firstStart) * firstTop;
  }

  for (let i = 0; i < N; i++) {
    const curStart = timings[i].start;
    const curEnd = timings[i].end;
    const top = containers[i].offsetTop;
    const h = containers[i].offsetHeight;
    const bot = top + h;

    if (t >= curStart && t <= curEnd) {
      const span = curEnd - curStart;
      const progress = span > 0 ? (t - curStart) / span : 0;
      return top + progress * h;
    }

    if (i + 1 < N) {
      const nextStart = timings[i + 1].start;
      const nextTop = containers[i + 1].offsetTop;
      if (t > curEnd && t < nextStart) {
        const gap = nextStart - curEnd;
        const progress = (t - curEnd) / gap;
        return bot + progress * (nextTop - bot);
      }
    }
  }

  const last = containers[N - 1];
  return last.offsetTop + last.offsetHeight;
}

function getTimeFromTickerY(y) {
  const containers = tpContent.querySelectorAll('.tp-line-container');
  if (!containers.length) return 0;
  const { timings, totalDur } = getResolvedTimings();
  const N = containers.length;

  const firstTop = containers[0].offsetTop;
  const firstStart = timings[0] ? timings[0].start : 0;

  if (y <= firstTop) {
    return firstStart > 0 ? (y / firstTop) * firstStart : 0;
  }

  for (let i = 0; i < N; i++) {
    const top = containers[i].offsetTop;
    const h = containers[i].offsetHeight;
    const bot = top + h;

    if (y >= top && y <= bot) {
      const p = h > 0 ? (y - top) / h : 0;
      return timings[i].start + p * (timings[i].end - timings[i].start);
    }

    if (i + 1 < N) {
      const nextTop = containers[i + 1].offsetTop;
      if (y > bot && y < nextTop) {
        const p = (y - bot) / (nextTop - bot);
        return timings[i].end + p * (timings[i + 1].start - timings[i].end);
      }
    }
  }

  return totalDur;
}

function getActiveLineIndex(t) {
  const { timings } = getResolvedTimings();
  const N = timings.length;
  if (!N) return -1;
  for (let i = 0; i < N; i++) {
    if (t >= timings[i].start && t < timings[i].end) return i;
    if (i + 1 < N && t >= timings[i].end && t < timings[i + 1].start) return i + 1;
  }
  if (t >= timings[N - 1].end) return N - 1;
  return 0;
}

function scrollToLine(idx, smooth = true) {
  if (!autoScroll || !autoScroll.checked) return;
  const containers = tpContent.querySelectorAll('.tp-line-container');
  const targetEl = containers[idx];
  if (targetEl) {
    const targetTop = Math.max(0, targetEl.offsetTop - 8);
    if (smooth) {
      tpView.scrollTo({ top: targetTop, behavior: 'smooth' });
    } else {
      tpView.scrollTop = targetTop;
    }
  }
}

function activateLine(idx, smooth = true) {
  tpIndex = Math.max(0, Math.min(idx, tpLines.length - 1));
  tpContent.querySelectorAll('.tp-line').forEach((el, i) => {
    el.classList.toggle('active', i === tpIndex);
  });
  tpContent.querySelectorAll('.tp-line-container').forEach((el, i) => {
    el.classList.toggle('active-dialogue', i === tpIndex);
  });
  const rail = document.getElementById('tpTickerRail');
  if (rail) {
    rail.querySelectorAll('.tp-rail-cue').forEach((cue, i) => {
      cue.classList.toggle('past', i < tpIndex);
      cue.classList.toggle('current', i === tpIndex);
    });
  }
  scrollToLine(tpIndex, smooth);
}

function updateTicker(t) {
  const head = document.getElementById('tpTickerHead');
  const fill = document.getElementById('tpTickerFill');
  const timeLabel = document.getElementById('tpTickerTime');
  const rail = document.getElementById('tpTickerRail');
  if (!head || !rail) return;

  const y = getTickerY(t);
  head.style.top = `${y}px`;
  if (fill) fill.style.height = `${y}px`;

  if (timeLabel) {
    const mins = Math.floor(t / 60);
    const secs = (t % 60).toFixed(1);
    timeLabel.textContent = `${mins > 0 ? mins + ':' : ''}${secs.padStart(mins > 0 ? 4 : 3, '0')}s`;
  }

  const activeIdx = getActiveLineIndex(t);
  if (activeIdx !== -1 && activeIdx !== tpIndex) {
    activateLine(activeIdx, true);
  }
}

let tickerLoopId = null;

function startTickerLoop() {
  if (tickerLoopId) cancelAnimationFrame(tickerLoopId);
  function step() {
    const vid = document.getElementById('dubVideo');
    if (vid && !vid.paused && !vid.ended) {
      updateTicker(vid.currentTime);
      tickerLoopId = requestAnimationFrame(step);
    } else {
      tickerLoopId = null;
    }
  }
  tickerLoopId = requestAnimationFrame(step);
}

function stopTickerLoop() {
  if (tickerLoopId) {
    cancelAnimationFrame(tickerLoopId);
    tickerLoopId = null;
  }
}

// Tap on any line to jump to it, or click the meta column / option to set emotion
tpContent.addEventListener('click', e => {
  const meta = e.target.closest('.tp-line-meta');
  if (meta) {
    const idx = parseInt(meta.dataset.i);
    cycleEmotion(idx);
    return;
  }
  
  const opt = e.target.closest('.picker-opt');
  if (opt) {
    const idx = parseInt(opt.dataset.i);
    const val = opt.dataset.val;
    setLineEmotion(idx, val);
    return;
  }
  
  const lineWrap = e.target.closest('.tp-line-wrap') || e.target.closest('.tp-line');
  if (lineWrap) {
    const container = lineWrap.closest('.tp-line-container');
    const idx = container ? parseInt(container.dataset.i) : parseInt(lineWrap.dataset.i);
    if (!isNaN(idx)) {
      activateLine(idx);
      const video = document.getElementById('dubVideo');
      const { timings } = getResolvedTimings();
      if (video && timings[idx] && typeof timings[idx].start === 'number') {
        video.currentTime = timings[idx].start;
        updateTicker(timings[idx].start);
      }
    }
  }
});

// Edit toggle
editBtn.addEventListener('click', () => {
  tpEditing = !tpEditing;
  if (tpEditing) {
    tpView.style.display = 'none';
    dubScript.style.display = 'block';
    dubScript.focus();
    editBtn.textContent = '✅';
  } else {
    buildTeleprompter();
    dubScript.style.display = 'none';
    tpView.style.display = 'block';
    editBtn.textContent = '✏️';
  }
});

function startTeleprompterScroll() {
  startTickerLoop();
}

function stopTeleprompterScroll() {
  stopTickerLoop();
}

// Hook into record start/stop
const _origStart = startRecording;
startRecording = function() {
  _origStart();
  startTeleprompterScroll();
  const video = document.getElementById('dubVideo');
  if (video) {
    if (!video.src || video.src === '' || video.src.endsWith('/')) {
      video.src = 'vid.mp4';
    }
    video.muted = true;
    video.currentTime = 0;
    video.play().catch(() => {});
  }
};

const _origStop = stopRecording;
stopRecording = function() {
  _origStop();
  stopTeleprompterScroll();
  const video = document.getElementById('dubVideo');
  if (video) {
    video.pause();
    video.currentTime = 0;
  }
  
  // Auto-switch to Takes tab so user can play back immediately
  setTimeout(() => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelector('.tab[data-tab="takes"]').classList.add('active');
    document.getElementById('panel-takes').classList.add('active');
  }, 300);
};

// Video Uploader Event
document.getElementById('videoUpload').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) {
    const url = URL.createObjectURL(file);
    const video = document.getElementById('dubVideo');
    video.src = url;
    video.dataset.filename = file.name;
    video.load();
  }
});

// Sync Teleprompter Active Line and Ticker to Video Timeline in Real-time
const dubVideo = document.getElementById('dubVideo');
if (dubVideo) {
  dubVideo.addEventListener('play', () => {
    const active = getActiveLineIndex(dubVideo.currentTime);
    activateLine(active, true);
    startTickerLoop();
  });
  dubVideo.addEventListener('pause', () => {
    stopTickerLoop();
    updateTicker(dubVideo.currentTime);
  });
  dubVideo.addEventListener('ended', () => {
    stopTickerLoop();
    updateTicker(dubVideo.currentTime);
  });
  dubVideo.addEventListener('timeupdate', () => updateTicker(dubVideo.currentTime));
  dubVideo.addEventListener('seeking', () => updateTicker(dubVideo.currentTime));
  dubVideo.addEventListener('seeked', () => updateTicker(dubVideo.currentTime));
  dubVideo.addEventListener('loadedmetadata', () => {
    updateCuePoints();
    updateTicker(dubVideo.currentTime);
  });
}

if (autoScroll) {
  autoScroll.addEventListener('change', () => {
    if (autoScroll.checked) {
      scrollToLine(tpIndex, true);
    }
  });
}

window.addEventListener('resize', () => {
  updateCuePoints();
  if (dubVideo) updateTicker(dubVideo.currentTime);
});

// Mic Toggle Button (Mute/Release mic stream)
let micStreamActive = true;
document.getElementById('btnMicToggle').addEventListener('click', async () => {
  const btn = document.getElementById('btnMicToggle');
  const iconOn = document.getElementById('iconMicOn');
  const iconOff = document.getElementById('iconMicOff');
  
  if (micStreamActive) {
    // Turn MIC OFF
    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
      micStream = null;
    }
    micStreamActive = false;
    btn.classList.add('muted');
    iconOn.style.display = 'none';
    iconOff.style.display = 'block';
    setStatus('🔇 Mic Off');
  } else {
    // Turn MIC ON
    micStreamActive = true;
    btn.classList.remove('muted');
    iconOn.style.display = 'block';
    iconOff.style.display = 'none';
    setStatus('● Ready');
    await initAudio();
    await getMic();
  }
});

// Auto suspend/release mic when Chrome loses focus or app is backgrounded on mobile
let wasActiveBeforeBackground = false;

document.addEventListener('visibilitychange', async () => {
  const btn = document.getElementById('btnMicToggle');
  const iconOn = document.getElementById('iconMicOn');
  const iconOff = document.getElementById('iconMicOff');

  if (document.hidden) {
    // User switched to another app on Pixel 6
    if (micStreamActive && micStream) {
      wasActiveBeforeBackground = true;
      micStream.getTracks().forEach(track => track.stop());
      micStream = null;
      if (ctx && ctx.state === 'running') {
        ctx.suspend();
      }
      setStatus('💤 Background (Mic Inactive)');
    }
  } else {
    // User switched back to Chrome / DubForge
    if (wasActiveBeforeBackground) {
      wasActiveBeforeBackground = false;
      await initAudio();
      await getMic();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume();
      }
      btn.classList.remove('muted');
      iconOn.style.display = 'block';
      iconOff.style.display = 'none';
      micStreamActive = true;
      setStatus('● Ready');
    }
  }
});

// Init
buildTeleprompter();

// ── Start Animation Loop ──────────────────
drawLoop();

