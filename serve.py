#!/usr/bin/env python3
"""本地开发服务器(开发版 index.html 通过 fetch 加载零件,需要 http)。
单文件版 dist/kitbash-standalone.html 无需服务器。

用法:python3 serve.py [端口]   然后打开 http://localhost:8123
"""
import http.server
import mimetypes
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".tflite")
mimetypes.add_type("application/octet-stream", ".binarypb")
mimetypes.add_type("application/octet-stream", ".data")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    print(f"三维组装台 → http://localhost:{PORT}")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
