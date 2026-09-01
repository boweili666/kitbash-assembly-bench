#!/usr/bin/env python3
"""Live view relay — mirror the bench viewport into another page / window.

The bench (index.html or the standalone file) POSTs JPEG frames here at
~8 fps; any browser can watch them live:

  GET  /              viewer page (small live window, Pop-out PiP button)
  GET  /embed         bare <img> page for iframes / other UIs
  GET  /stream.mjpg   multipart/x-mixed-replace MJPEG stream (any <img src>)
  GET  /frame.jpg     latest frame (for agents / polling)
  GET  /state.json    {frames, fps, age_ms, width_hint}
  POST /frame         body = JPEG bytes (Content-Type: image/jpeg)

Run:  python3 monitor.py [port]      (default 8124)
Then in the bench: Agent panel → Live view → Share view.
Watch at http://localhost:8124 (or http://<this-machine-ip>:8124 on the LAN).
"""
import http.server
import json
import socket
import sys
import threading
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8124


class Hub:
    def __init__(self):
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.frame = b""
        self.seq = 0
        self.ts = 0.0
        self.times = []  # recent frame timestamps for fps

    def push(self, data):
        with self.cond:
            self.frame = data
            self.seq += 1
            self.ts = time.time()
            self.times.append(self.ts)
            self.times = [t for t in self.times if self.ts - t < 3.0]
            self.cond.notify_all()

    def wait_next(self, last_seq, timeout):
        with self.cond:
            if self.seq == last_seq:
                self.cond.wait(timeout)
            return self.seq, self.frame

    def state(self):
        with self.lock:
            fps = len(self.times) / 3.0 if self.times else 0.0
            age = (time.time() - self.ts) * 1000 if self.ts else None
            return {"frames": self.seq, "fps": round(fps, 1),
                    "age_ms": None if age is None else int(age),
                    "bytes": len(self.frame)}


HUB = Hub()

VIEWER = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kitbash Live View</title>
<style>
:root{--bg:#14171c;--panel:#1c2128;--line:#2a313b;--ink:#e7ecf2;--dim:#8d97a5;--accent:#e8a33d;--live:#6fbf73;--danger:#e0604f}
*{box-sizing:border-box}html,body{height:100%;margin:0;background:var(--bg);color:var(--ink);
font-family:"IBM Plex Sans","Noto Sans SC",system-ui,sans-serif;font-size:13px}
.wrap{height:100%;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--panel)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--dim)}
.dot.live{background:var(--live);box-shadow:0 0 0 3px rgba(111,191,115,.2)}
.dot.dead{background:var(--danger)}
b{font-weight:600}.stat{color:var(--dim);font-variant-numeric:tabular-nums;font-family:"IBM Plex Mono",monospace;font-size:11.5px}
.sp{flex:1}button{border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--ink);font:inherit;font-size:12px;padding:5px 12px;cursor:pointer}
button:hover{background:var(--line)}
main{flex:1;display:flex;align-items:center;justify-content:center;padding:10px;min-height:0}
img{max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 8px 28px rgba(6,9,13,.5);background:#0c0f13}
#nosig{position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:var(--dim);font-size:15px;letter-spacing:.06em}
main{position:relative}
</style></head><body><div class="wrap">
<header><span id="dot" class="dot"></span><b>Kitbash Live View</b><span id="stat" class="stat">waiting…</span><span class="sp"></span>
<button id="pip" title="Pop out as a small floating window">Pop out</button>
<button id="reload" title="Reconnect stream">Reconnect</button></header>
<main><img id="live" src="/stream.mjpg" alt="live view"><div id="nosig">NO SIGNAL — start “Share view” in the bench</div></main>
</div>
<script>
var img=document.getElementById('live'),dot=document.getElementById('dot'),stat=document.getElementById('stat'),nosig=document.getElementById('nosig');
function poll(){fetch('/state.json').then(function(r){return r.json()}).then(function(s){
  var alive=s.age_ms!==null&&s.age_ms<3000;dot.className='dot '+(alive?'live':(s.frames?'dead':''));
  nosig.style.display=alive?'none':'flex';
  stat.textContent=alive?('LIVE · '+s.fps+' fps · '+(s.bytes/1024).toFixed(0)+' KB · '+img.naturalWidth+'×'+img.naturalHeight):(s.frames?'signal lost':'waiting for the bench…');
}).catch(function(){dot.className='dot dead';stat.textContent='relay offline'})}
setInterval(poll,1000);poll();
document.getElementById('reload').onclick=function(){img.src='/stream.mjpg?'+Date.now()};
// 画中画:把 MJPEG 画到 canvas → captureStream → <video> → requestPictureInPicture
var pipBtn=document.getElementById('pip'),pipVideo=null,pipCanvas=null,pipTimer=0;
if(!('pictureInPictureEnabled' in document)||!document.pictureInPictureEnabled)pipBtn.style.display='none';
pipBtn.onclick=function(){
  if(document.pictureInPictureElement){document.exitPictureInPicture();return}
  if(!pipCanvas){pipCanvas=document.createElement('canvas');pipVideo=document.createElement('video');pipVideo.muted=true;pipVideo.playsInline=true;
    pipVideo.srcObject=pipCanvas.captureStream(15);document.body.appendChild(pipVideo);pipVideo.style.cssText='position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';}
  function draw(){if(img.naturalWidth){if(pipCanvas.width!==img.naturalWidth){pipCanvas.width=img.naturalWidth;pipCanvas.height=img.naturalHeight}
    pipCanvas.getContext('2d').drawImage(img,0,0)}}
  draw();clearInterval(pipTimer);pipTimer=setInterval(draw,66);
  pipVideo.play().then(function(){return pipVideo.requestPictureInPicture()}).catch(function(e){alert('Picture-in-Picture unavailable: '+e.message)});
  pipVideo.addEventListener('leavepictureinpicture',function(){clearInterval(pipTimer)},{once:true});
};
</script></body></html>"""

EMBED = """<!doctype html><html><head><meta charset="utf-8"><title>Kitbash live</title>
<style>html,body{margin:0;height:100%;background:#0c0f13}img{width:100%;height:100%;object-fit:contain;display:block}</style>
</head><body><img src="/stream.mjpg" alt="live"></body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True   # TCP_NODELAY:避免小包 + 延迟 ACK 造成 ~300ms 卡顿

    def log_message(self, fmt, *args):  # 安静一点
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path != "/frame":
            return self._send(404, b"not found", "text/plain")
        n = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(n) if n else b""
        if not data:
            return self._send(400, b"empty", "text/plain")
        HUB.push(data)
        self._send(200, b'{"ok":true}', "application/json")

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            return self._send(200, VIEWER.encode("utf-8"), "text/html; charset=utf-8")
        if path == "/embed":
            return self._send(200, EMBED.encode("utf-8"), "text/html; charset=utf-8")
        if path == "/state.json":
            return self._send(200, json.dumps(HUB.state()).encode(), "application/json")
        if path == "/frame.jpg":
            seq, frame = HUB.wait_next(-1, 0)
            if not frame:
                return self._send(404, b"no frame yet", "text/plain")
            return self._send(200, frame, "image/jpeg")
        if path == "/stream.mjpg":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            last = -1
            try:
                while True:
                    seq, frame = HUB.wait_next(last, 1.0)
                    if not frame:
                        continue
                    last = seq
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " +
                                     str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
        return self._send(404, b"not found", "text/plain")


class DualStackServer(http.server.ThreadingHTTPServer):
    """同时接受 IPv4/IPv6:浏览器把 localhost 先解析成 ::1,若只监听 IPv4 会等
    ~250ms 才回退,每个请求都被拖慢。"""
    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass
        super().server_bind()


if __name__ == "__main__":
    try:
        srv = DualStackServer(("::", PORT), Handler)
    except OSError:
        srv = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
        srv.daemon_threads = True
    print(f"Kitbash live view relay → http://localhost:{PORT}   (viewer)   POST /frame from the bench")
    srv.serve_forever()
