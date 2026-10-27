"""Server-side « Lecture IA »: configuration, request shape, number check, cache and budget."""

import json

from app.llm_explain import Config, Explainer, build_request, stray_numbers

ITEM = {
    "id": "gain",
    "title": "Courbe de gain",
    "see": "Avec 365 alertes, trier par montant retrouve 75 % des euros frauduleux.",
    "why": "L'ordre de la file compte.",
    "limit": "Le tri par montant traite d'abord des alertes moins sûres.",
    "facts": ["365", "75 %", "1 234 €"],
}
ENV = {"LLM_PROVIDER": "openai", "LLM_API_KEY": "test-key-not-real", "LLM_MODEL": "some-model"}


def openai_reply(see, why="Pourquoi.", limit="Limite."):
    content = json.dumps({"see": see, "why": why, "limit": limit}, ensure_ascii=False)
    return {"choices": [{"message": {"content": content}}]}


class FakeTransport:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, url, headers, body, timeout):
        self.calls.append((url, headers, body))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def test_off_without_full_configuration():
    assert Config.from_env({}) is None
    assert Config.from_env({"LLM_PROVIDER": "static"}) is None
    assert Config.from_env({"LLM_PROVIDER": "openai", "LLM_MODEL": "m"}) is None  # no key
    assert Config.from_env({"LLM_PROVIDER": "unknown", "LLM_API_KEY": "k", "LLM_MODEL": "m"}) is None
    cfg = Config.from_env(ENV)
    assert cfg.provider == "openai" and cfg.base_url == "https://api.openai.com/v1"
    assert "test-key-not-real" not in repr(cfg)


def test_key_only_travels_in_a_header():
    for provider in ("openai", "anthropic"):
        cfg = Config.from_env({**ENV, "LLM_PROVIDER": provider})
        url, headers, body = build_request(cfg, "question")
        assert url.startswith("https://") and "test-key-not-real" not in url
        assert "test-key-not-real" in json.dumps(headers)
        assert "test-key-not-real" not in json.dumps(body)
        assert body["model"] == "some-model"
    source = Explainer.from_env(ENV).source
    assert "test-key-not-real" not in json.dumps(source)


def test_number_check():
    assert stray_numbers(["365 alertes, 75 % et 1 234 €."], ITEM["facts"]) == []
    assert stray_numbers(["En 2025, 80 % des alertes."], ITEM["facts"]) == ["2025", "80 %"]


def test_valid_answer_is_used_and_cached():
    fake = FakeTransport(openai_reply("Sur 365 alertes, 75 % des euros frauduleux sont retrouvés."))
    ex = Explainer(Config.from_env(ENV), transport=fake)
    first = ex.explain("42", ITEM)
    again = ex.explain("42", ITEM)
    assert first is again and len(fake.calls) == 1
    assert first["see"].startswith("Sur 365") and set(first["facts"]) == {"365", "75 %"}


def test_invented_number_is_retried_then_dropped():
    fake = FakeTransport(openai_reply("En 2025, 80 % des euros."), openai_reply("Environ 90 % des euros."))
    ex = Explainer(Config.from_env(ENV), transport=fake)
    assert ex.explain("42", ITEM) is None
    assert len(fake.calls) == 2 and ex.rejected == 2
    assert "2025" in fake.calls[1][2]["messages"][1]["content"]  # the retry says what was wrong


def test_retry_can_succeed():
    fake = FakeTransport(openai_reply("En 2025, 75 % des euros."), openai_reply("Avec 365 alertes, 75 % des euros."))
    ex = Explainer(Config.from_env(ENV), transport=fake)
    assert ex.explain("42", ITEM)["see"] == "Avec 365 alertes, 75 % des euros."


def test_errors_and_garbage_fall_back_to_static():
    ex = Explainer(Config.from_env(ENV), transport=FakeTransport(TimeoutError()))
    assert ex.explain("42", ITEM) is None
    ex = Explainer(Config.from_env(ENV), transport=FakeTransport({"choices": [{"message": {"content": "pas du json"}}]}, {}))
    assert ex.explain("42", ITEM) is None


def test_daily_budget():
    fake = FakeTransport(*[openai_reply("Avec 365 alertes.")] * 5)
    ex = Explainer(Config.from_env({**ENV, "LLM_MAX_CALLS_PER_DAY": "2"}), transport=fake)
    assert ex.explain("a", ITEM) and ex.explain("b", ITEM)
    assert ex.explain("c", ITEM) is None and len(fake.calls) == 2


def test_anthropic_answer_shape():
    content = json.dumps({"see": "Avec 365 alertes.", "why": "Pourquoi.", "limit": "Limite."})
    reply = {"content": [{"type": "text", "text": "```json\n" + content + "\n```"}]}
    ex = Explainer(Config.from_env({**ENV, "LLM_PROVIDER": "anthropic"}), transport=FakeTransport(reply))
    assert ex.explain("42", ITEM)["see"] == "Avec 365 alertes."


def test_real_http_round_trip_with_a_local_fake_provider():
    """The stdlib transport against a local OpenAI-compatible server: key in the header, JSON both ways."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    seen = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            seen["path"] = self.path
            seen["auth"] = self.headers["Authorization"]
            seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            out = json.dumps(openai_reply("Avec 365 alertes, 75 % des euros.")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        env = {**ENV, "LLM_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1"}
        got = Explainer.from_env(env).explain("42", ITEM)
    finally:
        server.shutdown()
    assert got["see"] == "Avec 365 alertes, 75 % des euros."
    assert seen["path"] == "/v1/chat/completions" and seen["auth"] == "Bearer test-key-not-real"
    assert "test-key-not-real" not in json.dumps(seen["body"])
