"""Check the chat from inside the container, with the real configuration, and print the full error if any.

    docker exec mutuelle-exemple-fraude python -m app.chat_check

The key is never printed.
"""

import asyncio
import traceback

from app.llm_chat import INSTRUCTIONS, MAX_REQUESTS, MAX_TOOL_CALLS, ChatAssistant, DemoData, UsageLimits, agent, build_context
from app.main import _dataset_meta, rules_doc
from app.state import state


async def main() -> None:
    bot = ChatAssistant.from_env()
    if bot is None:
        print("Chat désactivé : LLM_PROVIDER, LLM_API_KEY ou LLM_MODEL manquant, ou pydantic-ai absent.")
        return
    api = type(bot.model).__name__
    print(f"Fournisseur {bot.cfg.provider}, modèle {bot.cfg.model}, adresse {bot.cfg.base_url}, interface {api}")
    r = state.current()
    context = build_context(_dataset_meta(), rules_doc(), r.get_narratives())
    question = "Quelle est la précision de la règle des doublons ?"
    try:
        run = await agent.run(
            question,
            deps=DemoData(result=r, allowed=[context, question]),
            model=bot.model,
            instructions=f"{INSTRUCTIONS}\n\nCONTEXTE\n{context}",
            usage_limits=UsageLimits(request_limit=MAX_REQUESTS, tool_calls_limit=MAX_TOOL_CALLS),
        )
    except Exception:
        print("ÉCHEC :")
        print(bot.redact(traceback.format_exc()))
        return
    print(f"OK ({run.usage.requests} requêtes) : {run.output}")


if __name__ == "__main__":
    asyncio.run(main())
