#!/usr/bin/env python3
"""Local 429 stub for the auto-resume v2 plugin probe.

Every POST /v1/chat/completions answers with HTTP 429 and a ChatGPT-style
usage-limit body, so the v2 retry machinery (and any plugin hook on it) is
exercised without touching a real provider.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BODY = {
    "error": {
        "message": "You have hit your ChatGPT usage limit (plus plan). Try again in 3 hours.",
        "type": "usage_limit_reached",
        "code": "usage_limit_reached",
    }
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        raw = json.dumps(BODY).encode()
        self.send_response(429)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.send_header("retry-after", "60")
        self.end_headers()
        self.wfile.write(raw)
        sys.stderr.write(f"stub: 429 for {self.path}\n")
        sys.stderr.flush()

    def do_GET(self):  # noqa: N802
        raw = json.dumps({"data": [{"id": "m1", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):
        sys.stderr.write("stub: " + (fmt % args) + "\n")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18099
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
