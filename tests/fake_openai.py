"""A tiny OpenAI-compatible server for tests: asks for one tool call, then answers with its result.

Used by tests/test_llm_chat.py and by the CI, which runs the real container against it.
Run: python tests/fake_openai.py 9911
"""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar


def _reply(message: dict, finish: str) -> dict:
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": 0,
        "model": "some-model",
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


class Handler(BaseHTTPRequestHandler):
    seen: ClassVar[dict] = {"auth": [], "requests": 0}

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.seen["auth"].append(self.headers.get("Authorization"))
        self.seen["requests"] += 1
        tool_msgs = [m for m in body["messages"] if m.get("role") == "tool"]
        if not tool_msgs:
            function = {"name": "chiffres_scenario", "arguments": '{"scenario": 2}'}
            out = _reply(
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{"id": "call_1", "type": "function", "function": function}],
                },
                "tool_calls",
            )
        else:
            rappel = json.loads(tool_msgs[-1]["content"])["rappel"]
            out = _reply({"role": "assistant", "content": f"Le rappel de la règle des doublons est de {rappel}."}, "stop")
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def start(host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    Handler.seen = {"auth": [], "requests": 0}
    server = ThreadingHTTPServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 9911), Handler)
    srv.serve_forever()
