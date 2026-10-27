"""Probe the Pydantic AI API the chat will use; every finding is printed as a GitHub annotation."""

import asyncio
import importlib.metadata as md
import resource
from dataclasses import dataclass, field


def note(msg):
    print(f"::notice title=probe::{msg}")


note(f"pydantic-ai-slim {md.version('pydantic-ai-slim')} pydantic {md.version('pydantic')}")
rss0 = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
from pydantic_ai import Agent, ModelRetry, RunContext  # noqa: E402
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart  # noqa: E402
from pydantic_ai.models.function import AgentInfo, FunctionModel  # noqa: E402
from pydantic_ai.models.test import TestModel  # noqa: E402
from pydantic_ai.usage import UsageLimits  # noqa: E402

for mod, names in {
    "pydantic_ai.models.openai": ["OpenAIChatModel", "OpenAIModel"],
    "pydantic_ai.providers.openai": ["OpenAIProvider"],
    "pydantic_ai.models.anthropic": ["AnthropicModel"],
    "pydantic_ai.providers.anthropic": ["AnthropicProvider"],
}.items():
    m = __import__(mod, fromlist=["x"])
    note(f"{mod}: " + ", ".join(f"{n}={hasattr(m, n)}" for n in names))
from pydantic_ai.models.openai import OpenAIChatModel  # noqa: E402
from pydantic_ai.providers.openai import OpenAIProvider  # noqa: E402

rss1 = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
note(f"RSS after imports: {rss0 // 1024} MB -> {rss1 // 1024} MB")


@dataclass
class Deps:
    seen: list = field(default_factory=list)


agent = Agent(deps_type=Deps, instructions="Tu réponds en français.", output_type=str, output_retries=1)


@agent.tool
def count_alerts(ctx: RunContext[Deps], scenario: int | None = None) -> dict:
    """Count alerts of a scenario."""
    out = {"scenario": scenario, "alerts": 367}
    ctx.deps.seen.append(str(out))
    return out


@agent.output_validator
def check(ctx: RunContext[Deps], output: str) -> str:
    if "999" in output:
        raise ModelRetry("Nombre non vérifiable : 999")
    return output


calls = {"n": 0}


def fn(messages, info: AgentInfo) -> ModelResponse:
    calls["n"] += 1
    if calls["n"] == 1:
        return ModelResponse(parts=[ToolCallPart(tool_name="count_alerts", args={"scenario": 1})])
    if calls["n"] == 2:
        returns = [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
        note(f"tool return seen by model: {returns[-1].content!r}")
        return ModelResponse(parts=[TextPart("Il y a 999 alertes.")])
    return ModelResponse(parts=[TextPart("Il y a 367 alertes.")])


async def main():
    deps = Deps()
    r = await agent.run("Combien ?", deps=deps, model=FunctionModel(fn), usage_limits=UsageLimits(request_limit=6))
    note(f"output={r.output!r} requests={r.usage().requests} model_calls={calls['n']} deps.seen={deps.seen}")
    with agent.override(model=TestModel()):
        r2 = await agent.run("x", deps=Deps())
    note(f"TestModel output={r2.output!r}")
    m = OpenAIChatModel("some-model", provider=OpenAIProvider(api_key="test", base_url="http://127.0.0.1:9/v1"))
    note(f"OpenAIChatModel ok: {type(m).__name__}")
    try:
        await asyncio.wait_for(agent.run("x", deps=Deps(), model=m, model_settings={"timeout": 2}), 5)
    except Exception as exc:
        note(f"unreachable provider raises {type(exc).__module__}.{type(exc).__name__}")
    bad = FunctionModel(lambda m, i: ModelResponse(parts=[TextPart("toujours 999")]))
    try:
        await agent.run("x", deps=Deps(), model=bad)
    except Exception as exc:
        note(f"retries exhausted raises {type(exc).__module__}.{type(exc).__name__}")


asyncio.run(main())
