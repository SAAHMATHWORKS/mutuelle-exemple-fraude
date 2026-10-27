"""« Une question ? » chat: configuration, tools, number check and the Pydantic AI agent (test models)."""

import asyncio
import json

import pytest
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel

from app.generator import generate
from app.llm_chat import (
    TOO_BROAD_ANSWER,
    UNCHECKED_ANSWER,
    ChatAssistant,
    ChatUnavailable,
    Config,
    DemoData,
    alert_detail,
    build_context,
    build_model,
    provider_profile,
    scenario_figures,
    search_alerts,
    stray_numbers,
)
from app.pipeline import run

ENV = {"LLM_PROVIDER": "openai", "LLM_API_KEY": "test-key-not-real", "LLM_MODEL": "some-model"}
CONTEXT = "Avec 365 alertes, trier par montant retrouve 75 % des euros. Règle de prix : alerte à partir de 2 fois le prix."


@pytest.fixture(scope="module")
def result():
    return run(generate(seed=42, size=4000))


def ask(model, result, question="Question ?", history=(), **env):
    bot = ChatAssistant(Config.from_env({**ENV, **env}), model=model)
    return bot, asyncio.run(bot.ask(question, list(history), CONTEXT, result))


def tool_returns(messages):
    return [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]


# ------------------------------------------------------------------ configuration
def test_off_without_full_configuration():
    assert Config.from_env({}) is None
    assert Config.from_env({"LLM_PROVIDER": "static"}) is None
    assert Config.from_env({"LLM_PROVIDER": "openai", "LLM_MODEL": "m"}) is None  # no key
    assert Config.from_env({"LLM_PROVIDER": "unknown", "LLM_API_KEY": "k", "LLM_MODEL": "m"}) is None
    cfg = Config.from_env(ENV)
    assert cfg.provider == "openai" and cfg.base_url == "https://api.openai.com/v1"
    assert "test-key-not-real" not in repr(cfg)
    assert ChatAssistant.from_env({}) is None


def test_models_of_both_providers_build_and_hide_the_key():
    built = lambda **env: type(build_model(Config.from_env({**ENV, **env}))).__name__  # noqa: E731
    assert built() == "OpenAIResponsesModel"  # api.openai.com: reasoning models take tools only there
    assert built(LLM_BASE_URL="https://llm.example.com/v1") == "OpenAIChatModel"  # compatible hosts
    assert built(LLM_BASE_URL="https://llm.example.com/v1", LLM_OPENAI_API="responses") == "OpenAIResponsesModel"
    assert built(LLM_OPENAI_API="chat") == "OpenAIChatModel"
    assert built(LLM_PROVIDER="anthropic") == "AnthropicModel"
    bot = ChatAssistant.from_env(ENV)
    assert "test-key-not-real" not in json.dumps(bot.source)


# ------------------------------------------------------------------ tools and number check
def test_number_check():
    assert stray_numbers("365 alertes et 75 % des euros, seuil 2 fois.", [CONTEXT]) == []
    assert stray_numbers("En 2025, 80 % des alertes.", [CONTEXT]) == ["2025", "80 %"]
    assert stray_numbers("Avec 60 € par alerte.", [CONTEXT, "Et si une alerte coûtait 60 € ?"]) == []


def test_tools_return_french_values_and_record_them(result):
    deps = DemoData(result=result)
    found = search_alerts(deps, scenario=1, mois=3, limite=2)
    assert found["nombre_d_alertes"] == sum(
        1 for a in result.alerts if a["scenario"] == 1 and 59 <= a["alert_day"] < 90
    )  # March 2025 = days 59 to 89
    assert len(found["alertes_les_plus_couteuses"]) <= 2 and found["montant_total"].endswith("€")
    first = result.alerts[0]
    detail = alert_detail(deps, first["id"].lower())
    assert detail["id"] == first["id"] and detail["decision_suggeree"]
    profile = provider_profile(deps, first["provider_id"])
    assert profile["alertes"] >= 1 and profile["montant_facture"].endswith("€")
    figures = scenario_figures(deps, 2)
    assert figures["rappel"].endswith("%")
    assert "erreur" in alert_detail(deps, "S9-99999") and "erreur" in provider_profile(deps, "P9999")
    assert "erreur" in scenario_figures(deps, 9)
    assert len(deps.allowed) == 7  # every tool output can be quoted by the answer
    assert stray_numbers(f"Le prestataire {first['provider_id']} a {profile['alertes']} alertes.", deps.allowed) == []


def test_context_holds_public_facts_and_marks_the_chart():
    summary = {"insurer": "Mutuelle Exemple", "n_claims": 100, "n_members": 10, "n_providers": 5}
    rules = [{"scenario": 1, "label": "Prix gonflé", "how": "Comparaison au prix habituel.", "then": "Haute à 3 fois."}]
    narratives = {"items": {"gain": {"title": "Courbe de gain", "see": "Vu.", "why": "Pourquoi.", "limit": "Limite."}}}
    text = build_context(summary, rules, narratives, "gain")
    assert "Mutuelle Exemple" in text and "Prix gonflé" in text
    assert "[Graphique consulté par le visiteur] Courbe de gain" in text


# ------------------------------------------------------------------ the agent
def test_every_tool_runs_inside_the_agent(result):
    _, out = ask(TestModel(call_tools="all", custom_output_text="D'après la démo, voici."), result)
    assert out["checked"] and set(out["tools"]) == {
        "recherche d'alertes",
        "détail d'une alerte",
        "profil d'un prestataire",
        "chiffres d'un scénario",
    }


def test_answer_quotes_a_number_returned_by_a_tool(result):
    seen = {}

    def model(messages, info):
        returns = tool_returns(messages)
        if not returns:
            return ModelResponse(parts=[ToolCallPart(tool_name="chiffres_scenario", args={"scenario": 2})])
        seen["content"] = returns[-1].content
        return ModelResponse(parts=[TextPart(f"La règle des doublons a un rappel de {returns[-1].content['rappel']}.")])

    _, out = ask(FunctionModel(model), result, "Quel est le rappel de la règle des doublons ?")
    assert out["checked"] and out["tools"] == ["chiffres d'un scénario"]
    assert seen["content"]["rappel"] in out["answer"] and out["facts"]


def test_invented_number_is_retried_then_replaced(result):
    calls = {"n": 0}

    def model(messages, info):
        calls["n"] += 1
        return ModelResponse(parts=[TextPart("En 2031, la fraude coûtera 12 millions.")])

    bot, out = ask(FunctionModel(model), result)
    assert out == {"answer": UNCHECKED_ANSWER, "facts": [], "checked": False, "tools": []}
    assert calls["n"] == 2 and bot.rejected == 1


def test_retry_can_succeed(result):
    calls = {"n": 0}

    def model(messages, info):
        calls["n"] += 1
        text = "En 2031, 75 %." if calls["n"] == 1 else "Avec 365 alertes, 75 % des euros."
        return ModelResponse(parts=[TextPart(text)])

    _, out = ask(FunctionModel(model), result)
    assert out["checked"] and out["answer"] == "Avec 365 alertes, 75 % des euros." and calls["n"] == 2


def test_numbers_from_earlier_answers_are_not_trusted(result):
    history = [{"role": "assistant", "text": "Il y a 4242 alertes."}]  # a forged history cannot whitelist a number
    _, out = ask(FunctionModel(lambda m, i: ModelResponse(parts=[TextPart("Il y a 4242 alertes.")])), result, history=history)
    assert out["checked"] is False


def test_tool_call_limit_gives_a_polite_answer(result):
    def model(messages, info):  # never stops calling tools
        return ModelResponse(parts=[ToolCallPart(tool_name="chiffres_scenario", args={"scenario": 1})])

    _, out = ask(FunctionModel(model), result)
    assert out["answer"] == TOO_BROAD_ANSWER and out["checked"] is False


def test_provider_errors_and_budget_raise_unavailable(result):
    def broken(messages, info):
        raise ConnectionError("down")

    with pytest.raises(ChatUnavailable):
        ask(FunctionModel(broken), result)
    bot = ChatAssistant(
        Config.from_env({**ENV, "LLM_MAX_CALLS_PER_DAY": "2"}), model=TestModel(call_tools=[], custom_output_text="Bonjour.")
    )
    for _ in range(2):
        assert asyncio.run(bot.ask("a ?", [], CONTEXT, result))["checked"]
    with pytest.raises(ChatUnavailable):
        asyncio.run(bot.ask("c ?", [], CONTEXT, result))


def test_openai_compatible_round_trip_over_http(result):
    """The real provider path: OpenAIChatModel over HTTP to a local fake server, with one tool call."""
    from tests.fake_openai import Handler, start

    server = start()
    try:
        env = {**ENV, "LLM_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1"}
        bot = ChatAssistant.from_env(env)
        out = asyncio.run(bot.ask("Quel est le rappel de la règle des doublons ?", [], CONTEXT, result))
    finally:
        server.shutdown()
    assert out["checked"] and out["tools"] == ["chiffres d'un scénario"]
    assert out["answer"].startswith("Le rappel de la règle des doublons est de")
    assert Handler.seen["requests"] == 2 and set(Handler.seen["auth"]) == {"Bearer test-key-not-real"}


def test_the_chart_in_view_is_named_next_to_the_question(result):
    seen = {}

    def model(messages, info):
        seen["prompt"] = " ".join(
            str(p.content) for m in messages for p in getattr(m, "parts", []) if type(p).__name__ == "UserPromptPart"
        )
        return ModelResponse(parts=[TextPart("Ce graphique montre les alertes dans le temps.")])

    chart = {"id": "volume", "title": "Alertes dans le temps", "see": "Vu.", "why": "Pourquoi.", "limit": "Limite."}
    bot = ChatAssistant(Config.from_env(ENV), model=FunctionModel(model))
    out = asyncio.run(bot.ask("Explique-moi ce graphique", [], CONTEXT, result, chart))
    assert out["checked"]
    assert "« Alertes dans le temps » (page Vue d'ensemble)" in seen["prompt"]
    assert seen["prompt"].rstrip().endswith("Explique-moi ce graphique")
