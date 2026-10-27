"""Probe the Pydantic AI API step by step; findings and errors become GitHub annotations."""

import asyncio
import importlib.metadata as md
import inspect
import subprocess
import sys
import traceback
from dataclasses import dataclass, field


def note(msg):
    print(f"::notice title=probe::{msg}".replace("\n", " | "))


def err(step):
    print(f"::error title={step}::" + traceback.format_exc()[-900:].replace("\n", " | "))


note(f"pydantic-ai-slim {md.version('pydantic-ai-slim')}")
for label, code in {
    "core": "import pydantic_ai",
    "openai": "import pydantic_ai; from pydantic_ai.models.openai import OpenAIChatModel; from pydantic_ai.providers.openai import OpenAIProvider",
    "anthropic": "import pydantic_ai; from pydantic_ai.models.anthropic import AnthropicModel; from pydantic_ai.providers.anthropic import AnthropicProvider",
}.items():
    out = subprocess.run([sys.executable, "-c", code + "; import resource; print(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024)"], capture_output=True, text=True)
    note(f"RSS {label}: {out.stdout.strip()} MB {out.stderr[-200:]}")

import pydantic_ai  # noqa: E402
from pydantic_ai import Agent  # noqa: E402

note("pydantic_ai exports: " + ", ".join(n for n in ["Agent", "RunContext", "ModelRetry", "UsageLimits", "Tool"] if hasattr(pydantic_ai, n)))
note("Agent.__init__ params: " + ", ".join(inspect.signature(Agent.__init__).parameters))
note("Agent.run params: " + ", ".join(inspect.signature(Agent.run).parameters))
note("Agent attrs: " + ", ".join(a for a in ["tool", "tool_plain", "output_validator", "override", "run_sync", "instructions", "system_prompt"] if hasattr(Agent, a)))
import pydantic_ai.messages as msgs  # noqa: E402

note("messages: " + ", ".join(n for n in ["ModelResponse", "TextPart", "ToolCallPart", "ToolReturnPart", "ModelRequest", "UserPromptPart"] if hasattr(msgs, n)))
try:
    from pydantic_ai.models.function import AgentInfo, FunctionModel
    from pydantic_ai.models.test import TestModel

    note("FunctionModel/TestModel import ok")
except Exception:
    err("function-model")

try:
    from pydantic_ai import ModelRetry, RunContext

    @dataclass
    class Deps:
        seen: list = field(default_factory=list)

    agent = Agent(deps_type=Deps, instructions="Tu réponds en français.", output_type=str, retries=1)

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

    note("agent built")
except Exception:
    err("agent")

calls = {"n": 0}


def fn(messages, info):
    calls["n"] += 1
    if calls["n"] == 1:
        return msgs.ModelResponse(parts=[msgs.ToolCallPart(tool_name="count_alerts", args={"scenario": 1})])
    if calls["n"] == 2:
        rets = [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, msgs.ToolReturnPart)]
        note(f"tool return seen: {rets[-1].content!r}" if rets else "no tool return part")
        return msgs.ModelResponse(parts=[msgs.TextPart("Il y a 999 alertes.")])
    return msgs.ModelResponse(parts=[msgs.TextPart("Il y a 367 alertes.")])


async def main():
    try:
        deps = Deps()
        from pydantic_ai.usage import UsageLimits

        r = await agent.run("Combien ?", deps=deps, model=FunctionModel(fn), usage_limits=UsageLimits(request_limit=6), timeout=20)
        note(f"run ok: output={r.output!r} usage={r.usage()} calls={calls['n']} seen={deps.seen}")
        note("result attrs: " + ", ".join(a for a in ["output", "usage", "all_messages", "new_messages"] if hasattr(r, a)))
    except Exception:
        err("run")
    try:
        from pydantic_ai.usage import UsageLimits

        note("UsageLimits params: " + ", ".join(inspect.signature(UsageLimits).parameters))
    except Exception:
        err("usage-limits")
    try:
        with agent.override(model=TestModel()):
            r2 = await agent.run("x", deps=Deps())
        note(f"TestModel ok: {r2.output!r}")
    except Exception:
        err("testmodel")
    try:
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        m = OpenAIChatModel("some-model", provider=OpenAIProvider(api_key="test", base_url="http://127.0.0.1:9/v1"))
        try:
            await agent.run("x", deps=Deps(), model=m, model_settings={"timeout": 2}, timeout=5)
        except Exception as exc:
            note(f"unreachable provider raises {type(exc).__module__}.{type(exc).__name__}")
    except Exception:
        err("openai-model")
    try:
        from pydantic_ai.models.anthropic import AnthropicModel
        from pydantic_ai.providers.anthropic import AnthropicProvider

        AnthropicModel("m", provider=AnthropicProvider(api_key="test"))
        note("AnthropicModel ok")
    except Exception:
        err("anthropic-model")
    try:
        bad = FunctionModel(lambda m, i: msgs.ModelResponse(parts=[msgs.TextPart("toujours 999")]))
        await agent.run("x", deps=Deps(), model=bad)
        note("bad model did not raise")
    except Exception as exc:
        note(f"retries exhausted raises {type(exc).__module__}.{type(exc).__name__}")


asyncio.run(main())
