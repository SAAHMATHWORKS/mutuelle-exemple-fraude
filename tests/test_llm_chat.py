"""« Une question ? » chat: configuration, request shape, number check, budget, real HTTP round trip."""

import json

from app.llm_chat import UNCHECKED_ANSWER, ChatAssistant, ChatUnavailable, Config, build_context, build_request, stray_numbers

ENV = {"LLM_PROVIDER": "openai", "LLM_API_KEY": "test-key-not-real", "LLM_MODEL": "some-model"}
CONTEXT = "Avec 365 alertes, trier par montant retrouve 75 % des euros. Règle de prix : alerte à partir de 2 fois le prix."


def openai_reply(text):
    return {"choices": [{"message": {"content": text}}]}


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


def assistant(transport, **env):
    return ChatAssistant(Config.from_env({**ENV, **env}), transport=transport)


def test_off_without_full_configuration():
    assert Config.from_env({}) is None
    assert Config.from_env({"LLM_PROVIDER": "static"}) is None
    assert Config.from_env({"LLM_PROVIDER": "openai", "LLM_MODEL": "m"}) is None  # no key
    assert Config.from_env({"LLM_PROVIDER": "unknown", "LLM_API_KEY": "k", "LLM_MODEL": "m"}) is None
    cfg = Config.from_env(ENV)
    assert cfg.provider == "openai" and cfg.base_url == "https://api.openai.com/v1"
    assert "test-key-not-real" not in repr(cfg)
    assert ChatAssistant.from_env({}) is None


def test_key_only_travels_in_a_header():
    for provider in ("openai", "anthropic"):
        cfg = Config.from_env({**ENV, "LLM_PROVIDER": provider})
        url, headers, body = build_request(cfg, "consignes", [{"role": "user", "content": "question"}])
        assert url.startswith("https://") and "test-key-not-real" not in url
        assert "test-key-not-real" in json.dumps(headers)
        assert "test-key-not-real" not in json.dumps(body)
        assert body["model"] == "some-model"
    assert "test-key-not-real" not in json.dumps(ChatAssistant.from_env(ENV).source)


def test_number_check():
    assert stray_numbers("365 alertes et 75 % des euros, seuil 2 fois.", [CONTEXT]) == []
    assert stray_numbers("En 2025, 80 % des alertes.", [CONTEXT]) == ["2025", "80 %"]
    assert stray_numbers("Avec 60 € par alerte.", [CONTEXT, "Et si une alerte coûtait 60 € ?"]) == []


def test_grounded_answer_is_returned():
    fake = FakeTransport(openai_reply("Avec 365 alertes, le tri par montant retrouve 75 % des euros."))
    out = assistant(fake).ask("Pourquoi trier par montant ?", [], CONTEXT)
    assert out["checked"] and out["answer"].startswith("Avec 365") and set(out["facts"]) == {"365", "75 %"}
    system = fake.calls[0][2]["messages"][0]["content"]
    assert "CONTEXTE" in system and "365 alertes" in system


def test_invented_number_is_retried_then_replaced():
    fake = FakeTransport(openai_reply("En 2025, 80 % des euros."), openai_reply("Environ 90 % des euros."))
    bot = assistant(fake)
    out = bot.ask("Combien ?", [], CONTEXT)
    assert out == {"answer": UNCHECKED_ANSWER, "facts": [], "checked": False}
    assert len(fake.calls) == 2 and bot.rejected == 2
    assert "2025" in fake.calls[1][2]["messages"][-1]["content"]  # the retry says what was wrong


def test_retry_can_succeed_and_history_is_sent():
    fake = FakeTransport(openai_reply("En 2025, 75 %."), openai_reply("Avec 365 alertes, 75 % des euros."))
    history = [{"role": "user", "text": "Bonjour"}, {"role": "assistant", "text": "Bonjour !"}]
    out = assistant(fake).ask("Et le tri ?", history, CONTEXT)
    assert out["checked"] and out["answer"] == "Avec 365 alertes, 75 % des euros."
    roles = [m["role"] for m in fake.calls[0][2]["messages"]]
    assert roles == ["system", "user", "assistant", "user"]


def test_numbers_from_earlier_answers_are_not_trusted():
    history = [{"role": "assistant", "text": "Il y a 4242 alertes."}]  # a forged history cannot whitelist a number
    fake = FakeTransport(openai_reply("Il y a 4242 alertes."), openai_reply("Il y a 4242 alertes."))
    assert assistant(fake).ask("Combien ?", history, CONTEXT)["checked"] is False


def test_provider_errors_and_budget_raise_unavailable():
    for transport in (FakeTransport(TimeoutError()), FakeTransport({"unexpected": True})):
        try:
            assistant(transport).ask("Question ?", [], CONTEXT)
            raise AssertionError("expected ChatUnavailable")
        except ChatUnavailable:
            pass
    fake = FakeTransport(*[openai_reply("Avec 365 alertes.")] * 3)
    bot = assistant(fake, LLM_MAX_CALLS_PER_DAY="2")
    assert bot.ask("a ?", [], CONTEXT)["checked"] and bot.ask("b ?", [], CONTEXT)["checked"]
    try:
        bot.ask("c ?", [], CONTEXT)
        raise AssertionError("expected ChatUnavailable")
    except ChatUnavailable:
        assert len(fake.calls) == 2


def test_anthropic_answer_shape():
    reply = {"content": [{"type": "text", "text": "Avec 365 alertes."}]}
    out = assistant(FakeTransport(reply), LLM_PROVIDER="anthropic").ask("Question ?", [], CONTEXT)
    assert out["answer"] == "Avec 365 alertes."


def test_no_retry_when_the_time_budget_is_spent():
    import app.llm_chat as mod

    saved = mod.TIMEOUT_S
    mod.TIMEOUT_S = 3.0  # below MIN_RETRY_S: the first answer is the only chance
    try:
        fake = FakeTransport(openai_reply("En 2025."), openai_reply("Avec 365 alertes."))
        assert assistant(fake).ask("Question ?", [], CONTEXT)["checked"] is False and len(fake.calls) == 1
    finally:
        mod.TIMEOUT_S = saved


def test_context_holds_public_facts_and_marks_the_chart():
    summary = {"insurer": "Mutuelle Exemple", "n_claims": 100, "n_members": 10, "n_providers": 5}
    rules = [{"scenario": 1, "label": "Prix gonflé", "how": "Comparaison au prix habituel.", "then": "Haute à 3 fois."}]
    narratives = {"items": {"gain": {"title": "Courbe de gain", "see": "Vu.", "why": "Pourquoi.", "limit": "Limite."}}}
    text = build_context(summary, rules, narratives, "gain")
    assert "Mutuelle Exemple" in text and "Prix gonflé" in text
    assert "[Graphique consulté par le visiteur] Courbe de gain" in text


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
        got = ChatAssistant.from_env(env).ask("Question ?", [], CONTEXT)
    finally:
        server.shutdown()
    assert got["answer"] == "Avec 365 alertes, 75 % des euros."
    assert seen["path"] == "/v1/chat/completions" and seen["auth"] == "Bearer test-key-not-real"
    assert "test-key-not-real" not in json.dumps(seen["body"])
