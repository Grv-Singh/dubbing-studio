#!/usr/bin/env python3
"""DubForge Studio — HTTP server with /save endpoint for organized recordings."""
import http.server
import socketserver
import os
import json
import struct
import wave
import io
from datetime import datetime
from urllib.parse import urlparse, parse_qs

PORT = 8080
APP_DIR = os.path.dirname(os.path.abspath(__file__))
RECORDINGS_BASE = "/mnt/shared/Recordings/DubForge"


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)
    return path


def save_wav(raw_pcm: bytes, filename: str, sample_rate=48000, channels=1, bit_depth=16):
    """Write raw PCM bytes as a proper WAV file."""
    with wave.open(filename, 'wb') as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(bit_depth // 8)
        wf.setframerate(sample_rate)
        wf.writeframes(raw_pcm)


class DubForgeHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    # ── CORS / Security headers ───────────────────────────────────────────────
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Track-Name, X-Take-Name, X-Sample-Rate, X-Channels, X-Bit-Depth, X-Format")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    # ── POST /save & /merge ───────────────────────────────────────────────────
    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in ("/save", "/merge"):
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            self.send_error(400, "Empty body")
            return

        data = self.rfile.read(length)

        if parsed.path == "/merge":
            video_name = self.headers.get("X-Video-File", "vid.mp4").strip()
            video_path = os.path.join(APP_DIR, video_name)
            if not os.path.exists(video_path):
                video_path = os.path.join(APP_DIR, "vid.mp4")

            audio_path = os.path.join(APP_DIR, f"temp_{datetime.now().strftime('%H%M%S%f')}.wav")
            output_name = f"merged_{datetime.now().strftime('%H%M%S')}.mp4"
            output_path = os.path.join(APP_DIR, output_name)

            with open(audio_path, 'wb') as f:
                f.write(data)

            import subprocess
            clean_bg = os.path.join(APP_DIR, "vid_bg_clean.m4a")
            if os.path.exists(clean_bg) and "vid.mp4" in video_path.lower():
                # Studio Broadcast Voice & Ducking Pipeline:
                # 1. Voice: 80Hz highpass + 50Hz/100Hz hum reject + 3kHz presence boost
                # 2. Intro mute: mic faded in right at dialogue start (5.8s) so intro BGM has zero mic noise/buzz
                # 3. Vocal Amplitude Boost: dynaudnorm (m=12.0, p=0.96) + volume=1.6 delivers full, loud, punchy dialogue amplitude
                # 4. Ducking: BGM at 0.38 ducks automatically by -12dB when speaking, swells back in pauses
                # 5. Output: amix normalize=0 + -0.8dB peak limiter for maximum clarity and presence
                filter_str = (
                    "[1:a]highpass=f=80,bandreject=f=50:w=6,bandreject=f=100:w=6,"
                    "equalizer=f=3000:t=q:w=1.2:g=2.8,"
                    "afade=t=in:st=5.8:d=0.3,"
                    "dynaudnorm=f=150:g=25:m=12.0:p=0.96,volume=1.6[voice];"
                    "[voice]asplit=2[v_mix][v_sc];"
                    "[0:a]volume=0.38,equalizer=f=1800:t=q:w=1.5:g=-4[bg_raw];"
                    "[bg_raw][v_sc]sidechaincompress=threshold=0.04:ratio=6:attack=15:release=250[bg_ducked];"
                    "[bg_ducked][v_mix]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=-0.8dB[aout]"
                )
                cmd = [
                    "ffmpeg", "-y",
                    "-i", clean_bg,
                    "-i", audio_path,
                    "-i", video_path,
                    "-filter_complex", filter_str,
                    "-map", "2:v:0",
                    "-map", "[aout]",
                    "-c:v", "copy",
                    "-c:a", "aac",
                    "-b:a", "192k",
                    output_path
                ]
            else:
                filter_str = (
                    "[1:a]highpass=f=80,bandreject=f=50:w=6,bandreject=f=100:w=6,"
                    "equalizer=f=3000:t=q:w=1.2:g=2.8,"
                    "dynaudnorm=f=150:g=25:m=12.0:p=0.96,volume=1.6[voice];"
                    "[voice]asplit=2[v_mix][v_sc];"
                    "[0:a]equalizer=f=1200:t=q:w=1.5:g=-12,equalizer=f=2400:t=q:w=1.5:g=-12,stereotools=mlev=0.3:slev=1.3,volume=0.45[bg_raw];"
                    "[bg_raw][v_sc]sidechaincompress=threshold=0.04:ratio=6:attack=15:release=250[bg_ducked];"
                    "[bg_ducked][v_mix]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=-0.8dB[aout]"
                )
                cmd = [
                    "ffmpeg", "-y",
                    "-i", video_path,
                    "-i", audio_path,
                    "-filter_complex", filter_str,
                    "-map", "0:v:0",
                    "-map", "[aout]",
                    "-c:v", "copy",
                    "-c:a", "aac",
                    "-b:a", "192k",
                    output_path
                ]
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if result.returncode != 0:
                cmd_fallback = [
                    "ffmpeg", "-y",
                    "-i", video_path,
                    "-i", audio_path,
                    "-c:v", "copy",
                    "-c:a", "aac",
                    "-map", "0:v:0",
                    "-map", "1:a:0",
                    output_path
                ]
                result = subprocess.run(cmd_fallback, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

            try:
                os.remove(audio_path)
            except Exception:
                pass

            if result.returncode == 0:
                resp = json.dumps({
                    "ok": True,
                    "merged_video_url": f"/{output_name}"
                }).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", len(resp))
                self.end_headers()
                self.wfile.write(resp)
            else:
                err_msg = result.stderr.decode()
                print(f"[DubForge] ❌ FFmpeg Error: {err_msg}")
                resp = json.dumps({
                    "ok": False,
                    "error": err_msg
                }).encode()
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", len(resp))
                self.end_headers()
                self.wfile.write(resp)
            return

        # Headers sent by the client
        track_name  = self.headers.get("X-Track-Name", "Unknown_Track").strip()
        take_name   = self.headers.get("X-Take-Name", f"Take_{datetime.now().strftime('%H%M%S')}").strip()
        sample_rate = int(self.headers.get("X-Sample-Rate", "48000"))
        channels    = int(self.headers.get("X-Channels", "1"))
        bit_depth   = int(self.headers.get("X-Bit-Depth", "16"))
        fmt         = self.headers.get("X-Format", "wav").lower()  # "wav" or "webm"

        # Sanitize names for filesystem
        safe_track = "".join(c if c.isalnum() or c in (' ', '-', '_') else '_' for c in track_name).strip()
        safe_take  = "".join(c if c.isalnum() or c in (' ', '-', '_') else '_' for c in take_name).strip()

        # Directory: /mnt/shared/Recordings/DubForge/2026-08-18/Vocal_Lead/
        date_str = datetime.now().strftime("%Y-%m-%d")
        session_dir = ensure_dir(os.path.join(RECORDINGS_BASE, date_str, safe_track))

        # Avoid overwrites — find next available index
        existing = [f for f in os.listdir(session_dir) if f.startswith(safe_take)]
        idx = len(existing) + 1
        base_name = f"{safe_take}_{idx:02d}" if existing else safe_take

        if fmt == "wav":
            filepath = os.path.join(session_dir, f"{base_name}.wav")
            # Browser sends a complete, valid WAV file (RIFF header + data)
            # Just write raw bytes — no re-encoding needed
            with open(filepath, 'wb') as f:
                f.write(data)
        else:
            # Fallback: save raw webm/opus blob as-is
            ext = fmt if fmt in ("webm", "ogg", "mp3") else "webm"
            filepath = os.path.join(session_dir, f"{base_name}.{ext}")
            with open(filepath, 'wb') as f:
                f.write(data)

        size_kb = os.path.getsize(filepath) / 1024
        rel_path = filepath.replace(RECORDINGS_BASE, "").lstrip("/")
        print(f"[DubForge] ✅ Saved: {filepath}  ({size_kb:.1f} KB)")

        # JSON response
        resp = json.dumps({
            "ok": True,
            "path": filepath,
            "relative": rel_path,
            "size_kb": round(size_kb, 1),
            "format": "wav" if fmt == "wav" else fmt,
            "sample_rate": sample_rate,
            "channels": channels,
            "bit_depth": bit_depth,
        }).encode()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)

    # ── GET /recordings  — list saved files ───────────────────────────────────
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/recordings":
            self._list_recordings()
            return
        # Default static file serving
        super().do_GET()

    def _list_recordings(self):
        files = []
        if os.path.isdir(RECORDINGS_BASE):
            for root, dirs, filenames in os.walk(RECORDINGS_BASE):
                dirs.sort(); filenames.sort()
                for fn in filenames:
                    fp = os.path.join(root, fn)
                    rel = fp.replace(RECORDINGS_BASE, "").lstrip("/")
                    files.append({
                        "path": fp,
                        "relative": rel,
                        "name": fn,
                        "size_kb": round(os.path.getsize(fp) / 1024, 1),
                        "modified": datetime.fromtimestamp(os.path.getmtime(fp)).isoformat(),
                    })

        resp = json.dumps({"recordings": files, "base": RECORDINGS_BASE}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, format, *args):
        print(f"[DubForge] {self.address_string()} — {format % args}")


if __name__ == "__main__":
    import socket, threading
    ensure_dir(RECORDINGS_BASE)
    os.chdir(APP_DIR)

    # Get all local IPs
    ips = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ip = info[4][0]
            if ':' not in ip and ip != '127.0.0.1':
                ips.append(ip)
    except Exception:
        pass

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), DubForgeHandler) as httpd:
        print(f"\n[DubForge Studio] ✅ Running on port {PORT}")
        print(f"  → http://localhost:{PORT}")
        for ip in set(ips):
            print(f"  → http://{ip}:{PORT}")
        print(f"  Recordings → {RECORDINGS_BASE}\n")
        httpd.serve_forever()
