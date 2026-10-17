"""Verification-only loopback fixture. The serving socket is never handed off."""
import http.server
import json
import os
import sys
import threading

identity = {"token": sys.argv[1], "pid": os.getpid()}


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/__survey_playwright_owner":
            payload = json.dumps(identity).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            super().do_GET()

    def end_headers(self):
        self.send_header("X-Survey-Playwright-Owner", identity["token"])
        super().end_headers()


# The OS assigns the port to the actual HTTP server, which keeps it until exit.
with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
    identity["port"] = server.server_port
    print(json.dumps(identity), flush=True)

    def parent_lifetime():
        # EOF also covers an abruptly lost coordinator: never leave an orphan.
        sys.stdin.buffer.read()
        os._exit(0)

    threading.Thread(target=parent_lifetime, daemon=True).start()
    server.serve_forever()
