"""Dynamic « Lecture IA »: a language model, called from the server, rewrites a chart commentary.

Off by default: without configuration the demo serves the static commentaries of
``app/narratives.py`` and calls no external service.

Configuration (server ``.env`` only; never in the repository, the image or the browser)::

    LLM_PROVIDER=openai        # "openai" = any OpenAI-compatible API (see LLM_BASE_URL), or "anthropic"
    LLM_API_KEY=...            # the secret; read once at startup, never logged nor returned
    LLM_MODEL=...              # model name of the provider (required)
    LLM_BASE_URL=              # optional, for an OpenAI-compatible API hosted elsewhere
    LLM_MAX_CALLS_PER_DAY=200  # hard budget; past it, the static text is served

Guarantees, whatever the model writes:

* the model only receives the chart title, its recorded facts and the reviewed
  static reading; it never sees raw claim rows;
* every number in its answer must be one of the chart's facts (same check as the
  static texts); otherwise the answer is retried once, then dropped for the
  static text;
* one call per chart and dataset at most (in-memory cache, one lock per chart),
  so the showcase makes at most one call per chart per container start.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

log = logging.getLogger("app.llm_explain")

PROVIDERS = ("openai", "anthropic")
DEFAULT_BASE_URL = {"openai": "https://api.openai.com/v1", "anthropic": "https://api.anthropic.com/v1"}
# Whole budget of one chart, retry included: under the page's 30 s wait and Nginx's 30 s proxy timeout.
TIMEOUT_S = 24.0
MIN_RETRY_S = 6.0
MAX_PART_CHARS = 420

SYSTEM_PROMPT = (
    "Tu commentes un graphique d'une démo de détection de fraude en assurance santé, construite sur des données "
    "entièrement synthétiques (assureur fictif). Tu écris pour un gestionnaire de sinistres et pour un responsable IA, "
    "en français clair, sans jargon inutile.\n"
    "Règles absolues :\n"
    "1. N'écris aucun nombre qui ne figure pas dans la liste « chiffres_autorises » : pas d'année, pas de rang, "
    "pas de pourcentage recalculé, pas de chiffre écrit en lettres. Recopie chaque nombre exactement comme dans la liste.\n"
    "2. Ne contredis pas la « lecture_de_reference » et n'ajoute aucun fait qu'elle ne contient pas.\n"
    "3. Ne cite aucune entreprise, personne ou donnée réelle.\n"
    'Réponds uniquement par un objet JSON {"see": "...", "why": "...", "limit": "..."} : '
    "ce que montre le graphique, pourquoi c'est important pour la décision, et la limite à garder en tête. "
    "Une ou deux phrases par champ, 45 mots au plus."
)

# A number as written in the commentaries: 1 234,5 (thin or no-break spaces), optionally followed by % or €.
_NUMBER = re.compile(r"\d(?:[\d  ]|(?<=\d) (?=\d{3}\b))*(?:[.,]\d+)?(?:[   ]?[%€])?")


def _value(token: str) -> str:
    """Canonical value of a number token: '1 234,50 €' -> '1234.5'."""
    digits = re.sub(r"[^\d,.]", "", token).replace(",", ".")
    try:
        return f"{float(digits):g}"
    except ValueError:
        return digits


def numbers_in(text: str) -> list[str]:
    return _NUMBER.findall(text)


def stray_numbers(parts: list[str], facts: list[str]) -> list[str]:
    """Numbers written in ``parts`` whose value is not the value of any recorded fact."""
    allowed = {_value(n) for f in facts for n in numbers_in(f)}
    return [n for p in parts for n in numbers_in(p) if _value(n) not in allowed]


@dataclass(frozen=True)
class Config:
    provider: str
    model: str
    api_key: str = field(repr=False)
    base_url: str = ""
    max_calls_per_day: int = 200

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Config | None:
        env = os.environ if env is None else env
        provider = env.get("LLM_PROVIDER", "").strip().lower()
        if provider in ("", "static", "none", "off"):
            return None
        if provider not in PROVIDERS:
            log.warning("Lecture IA : fournisseur %r inconnu (attendu : %s) ; version statique.", provider, ", ".join(PROVIDERS))
            return None
        key, model = env.get("LLM_API_KEY", "").strip(), env.get("LLM_MODEL", "").strip()
        if not key or not model:
            log.warning("Lecture IA : LLM_API_KEY ou LLM_MODEL manquant ; version statique.")
            return None
        try:
            cap = max(0, int(env.get("LLM_MAX_CALLS_PER_DAY", "200") or 200))
        except ValueError:
            cap = 200
        base = (env.get("LLM_BASE_URL", "").strip() or DEFAULT_BASE_URL[provider]).rstrip("/")
        return cls(provider=provider, model=model, api_key=key, base_url=base, max_calls_per_day=cap)


Transport = Callable[[str, dict, dict, float], dict]


def _http_post(url: str, headers: dict, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # fixed https endpoint from the server config
        return json.loads(resp.read().decode())


def build_request(cfg: Config, user_content: str) -> tuple[str, dict, dict]:
    """URL, headers and body of one call. The key only ever goes into a header."""
    if cfg.provider == "anthropic":
        return (
            f"{cfg.base_url}/messages",
            {"x-api-key": cfg.api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            {
                "model": cfg.model,
                "max_tokens": 700,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": user_content}],
            },
        )
    return (
        f"{cfg.base_url}/chat/completions",
        {"Authorization": f"Bearer {cfg.api_key}", "Content-Type": "application/json"},
        {
            "model": cfg.model,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user_content}],
        },
    )


def _answer_text(cfg: Config, payload: dict) -> str:
    if cfg.provider == "anthropic":
        return "".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text")
    return payload["choices"][0]["message"]["content"] or ""


def _parse(text: str) -> dict | None:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    parts = {k: " ".join(str(data.get(k, "")).split()) for k in ("see", "why", "limit")}
    if not all(parts.values()) or any(len(v) > MAX_PART_CHARS for v in parts.values()):
        return None
    return parts


class Explainer:
    """Calls the configured model once per (dataset, chart), checks the numbers, caches the result."""

    def __init__(self, cfg: Config, transport: Transport | None = None) -> None:
        self.cfg = cfg
        self._transport = transport or _http_post
        self._cache: dict[tuple[str, str], dict] = {}
        self._locks: dict[tuple[str, str], threading.Lock] = {}
        self._guard = threading.Lock()
        self._day = ""
        self._calls = 0
        self.rejected = 0  # answers dropped by the number check (for the logs and tests)

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Explainer | None:
        cfg = Config.from_env(env)
        if cfg:
            log.info("Lecture IA dynamique : fournisseur %s, modèle %s.", cfg.provider, cfg.model)
        return cls(cfg) if cfg else None

    @property
    def source(self) -> dict:
        return {
            "kind": "llm",
            "model": self.cfg.model,
            "label": (
                f"Commentaire généré à la demande par un modèle de langue ({self.cfg.model}), à partir des seuls chiffres "
                "du graphique ; chaque nombre a été vérifié automatiquement avant affichage."
            ),
        }

    def _take_budget(self) -> bool:
        with self._guard:
            today = time.strftime("%Y-%m-%d")
            if today != self._day:
                self._day, self._calls = today, 0
            if self._calls >= self.cfg.max_calls_per_day:
                return False
            self._calls += 1
            return True

    def explain(self, dataset_key: str, item: dict) -> dict | None:
        """The model's reading of ``item`` (a static commentary), or None to fall back to the static text."""
        key = (dataset_key, item["id"])
        with self._guard:
            if key in self._cache:
                return self._cache[key]
            lock = self._locks.setdefault(key, threading.Lock())
        with lock:  # one call per chart, even if several visitors open it at once
            if key in self._cache:
                return self._cache[key]
            result = self._ask(item)
            if result is not None:
                with self._guard:
                    self._cache[key] = result
            return result

    def _ask(self, item: dict) -> dict | None:
        user = json.dumps(
            {
                "titre": item["title"],
                "chiffres_autorises": sorted(set(item["facts"])),
                "lecture_de_reference": {k: item[k] for k in ("see", "why", "limit")},
            },
            ensure_ascii=False,
        )
        deadline = time.monotonic() + TIMEOUT_S
        for attempt in (1, 2):
            remaining = deadline - time.monotonic()
            if attempt == 2 and remaining < MIN_RETRY_S:
                log.warning("Lecture IA : plus le temps de redemander %s ; version statique.", item["id"])
                return None
            if not self._take_budget():
                log.warning("Lecture IA : budget quotidien atteint ; version statique.")
                return None
            url, headers, body = build_request(self.cfg, user)
            try:
                parts = _parse(_answer_text(self.cfg, self._transport(url, headers, body, remaining)))
            except urllib.error.HTTPError as exc:
                log.warning("Lecture IA : le fournisseur a répondu %s ; version statique.", exc.code)
                return None
            except Exception as exc:  # network error, timeout, unexpected shape: never break the page
                log.warning("Lecture IA : appel impossible (%s) ; version statique.", type(exc).__name__)
                return None
            if parts is None:
                log.warning("Lecture IA : réponse illisible pour %s (essai %d).", item["id"], attempt)
                continue
            stray = stray_numbers(list(parts.values()), item["facts"])
            if stray:
                self.rejected += 1
                log.warning("Lecture IA : chiffres non autorisés %s pour %s (essai %d).", stray, item["id"], attempt)
                user += f"\nTa réponse précédente contenait des nombres interdits : {', '.join(stray)}. Recommence sans eux."
                continue
            facts = [n.rstrip("\u202f\u00a0 ") for p in parts.values() for n in numbers_in(p)]
            return {"id": item["id"], "title": item["title"], **parts, "facts": facts}
        return None
