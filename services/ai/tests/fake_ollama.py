"""A deterministic stand-in for Ollama's /api/chat and /api/embed, used only by
scripts/wsl/ai-docker-check.sh to exercise the real HTTP backends without a model.

The chat answer cites the first item id it sees and also invents a decision with an id
that does not exist, so the check can confirm the worker drops it.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIM = 8


def embed(text: str) -> list[float]:
    vec = [0.0] * DIM
    vec[0] = 0.05
    for word in re.findall(r"\w+", text.lower()):
        digest = hashlib.sha256(word.encode()).digest()
        vec[digest[0] % DIM] += 1.0 if digest[1] % 2 else -1.0
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 (http.server naming)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if self.path == "/api/embed":
            out = {"embeddings": [embed(text) for text in body["input"]]}
        elif self.path == "/api/chat":
            ids = re.findall(r'"id": "([^"]+)"', body["messages"][-1]["content"])
            content = {
                "summary": "Fake summary.",
                "decisions": [
                    {"text": "Real decision", "citations": ids[:1]},
                    {"text": "Invented decision", "citations": ["does-not-exist"]},
                ],
                "actionItems": [],
            }
            out = {"message": {"role": "assistant", "content": json.dumps(content)}}
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args: object) -> None:
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11434
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
