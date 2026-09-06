# DubForge Studio 🎙️

DubForge Studio is a professional, lightweight web-based mobile & desktop dubbing and voice recording studio. Designed for voice actors, content creators, and dubbing artists to record and sync multi-take voiceovers to video in real-time.

---

## ✨ Features

- 📜 **Real-time Script Teleprompter:**
  - Dynamic vertical timeline ticker rail along the left border.
  - Video timeline synchronization with 60 FPS smooth animation loop.
  - Auto-scroll keeps the currently spoken line at the top of the box.
  - Emotion tags (Gentle, Mature, Slow, Serious, Intense) and timing cues.
  - Interactive rail seeking to scrub video to dialogue points.

- 🎙️ **Voice Recording & Takes Management:**
  - High-fidelity mono PCM WAV capture (16-bit, 48kHz / 44.1kHz).
  - Multi-take recording with instant playback.
  - Visual waveform and recording meter.

- 🎚️ **Studio-Grade Audio Balance & Mixing:**
  - **Dynamic Sidechain Ducking:** BGM ducks automatically by -10dB when the speaker speaks, smoothly swelling back during pauses.
  - **Vocal Presence EQ & High-pass Filter:** Low-end rumble cutoff (85Hz) with 3kHz clarity boost.
  - **Dynamic Leveling & Peak Limiter:** Automatic broadcast-standard leveling (`dynaudnorm`) with -1.0dB true-peak limiting.

- ⚡ **Lightweight Python Server:**
  - Zero heavy dependencies; standard library HTTP server.
  - Automatic FFmpeg multi-stream video/audio merge endpoint (`/merge`).
  - Organized recordings endpoint (`/save`).

---

## 🚀 Quick Start

### 1. Prerequisites
- Python 3.8+
- FFmpeg (with `dynaudnorm` & `sidechaincompress` support)

### 2. Start the Studio Server
```bash
python3 server.py
```
Open your browser at `http://localhost:8080`.

### 3. Usage
1. Open the **Script** tab to review your dialogue and timestamps.
2. Tap **⏺ (Record)** on the dock. The video will play and the teleprompter will glide down in real-time.
3. Once done, tap **⏹ (Stop)**. The studio automatically normalizes, ducks BGM, merges the video, and presents the take in the **Takes** tab for immediate review.
