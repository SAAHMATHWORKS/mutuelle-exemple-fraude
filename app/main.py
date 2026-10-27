"""FastAPI application: JSON API + static French front end."""

from __future__ import annotations

import hashlib
import math
from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.catalog import ACTS, DECISIONS, DIAGNOSES, INSURER_NAME, PROVIDER_TYPES, SCENARIOS
from app.detectors.price import price_history
from app.generator import MAX_SIZE, MIN_SIZE, N_DAYS, PERIOD_START
from app.llm_explain import Explainer
from app.rules_doc import rules as rules_doc
from app.state import state

STATIC_DIR = Path(__file__).parent / "static"
VERSIONED_ASSETS = ("styles.css", "vendor/chart.umd.min.js", "app.js")


def _index_html() -> str:
    """index.html with a content hash on each asset URL, so a new deployment is never
    hidden by a browser or CDN cache of the previous app.js or stylesheet."""
    digest = hashlib.sha256()
    for name in VERSIONED_ASSETS:
        digest.update((STATIC_DIR / name).read_bytes())
    version = digest.hexdigest()[:12]
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    for name in VERSIONED_ASSETS:
        html = html.replace(f'/static/{name}"', f'/static/{name}?v={version}"')
    return html


INDEX_HTML = _index_html()


def iso(day: int) -> str:
    return (PERIOD_START + timedelta(days=int(day))).isoformat()


def day_of(value: date) -> int:
    return (value - PERIOD_START).days


@asynccontextmanager
async def lifespan(_: FastAPI):
    result = state.current()
    state.curve(result.dataset.seed, result.dataset.size)  # starts in background
    yield


app = FastAPI(
    title=f"{INSURER_NAME} — détection de fraude par scénarios",
    description="Démo sur données entièrement synthétiques.",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,  # the Swagger UI loads assets from a CDN; the app must work offline
    redoc_url=None,
)


# Server-side language model for « Lecture IA »: None (static texts) unless LLM_* variables are set.
explainer = Explainer.from_env()


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "connect-src 'self'; object-src 'none'; base-uri 'none'"
    )
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


# ---------------------------------------------------------------- schemas
class Health(BaseModel):
    status: Literal["ok"]
    mode: Literal["live", "vitrine"]
    claims: int
    alerts: int
    explain: Literal["static", "llm"]


class RegenerateRequest(BaseModel):
    seed: int = Field(42, ge=0, le=1_000_000)
    size: int = Field(20_000, ge=MIN_SIZE, le=MAX_SIZE)
    noise_level: float = Field(0.2, ge=0.0, le=1.0)


class AlertSummary(BaseModel):
    id: str
    scenario: int
    scenario_label: str
    severity: Literal["haute", "moyenne", "faible"]
    score: float
    date: str
    member_id: str
    provider_id: str | None
    n_lines: int
    amount: float
    decision: str
    decision_label: str
    reason: str


class AlertPage(BaseModel):
    total: int
    page: int
    page_size: int
    pages: int
    items: list[AlertSummary]


class EvidenceRow(BaseModel):
    line_id: int
    date: str
    role: Literal["signalée", "contexte"]
    member_id: str
    provider_id: str
    provider_type: str
    act_code: str
    act_label: str
    diagnosis_code: str
    diagnosis_label: str
    billed_amount: float


class AlertDetail(AlertSummary):
    details: dict
    evidence: list[EvidenceRow]
    chart: dict | None
    ground_truth: dict


# ----------------------------------------------------------------- helpers
def _summary(a: dict) -> dict:
    return {
        "id": a["id"],
        "scenario": a["scenario"],
        "scenario_label": a["scenario_label"],
        "severity": a["severity"],
        "score": a["score"],
        "date": iso(a["alert_day"]),
        "member_id": a["member_id"],
        "provider_id": a["provider_id"],
        "n_lines": a["n_lines"],
        "amount": a["amount"],
        "decision": a["decision"],
        "decision_label": DECISIONS[a["decision"]],
        "reason": a["reason"],
    }


def _dataset_meta() -> dict:
    r = state.current()
    d = r.dataset
    return {
        "insurer": INSURER_NAME,
        "seed": d.seed,
        "size": d.size,
        "noise_level": d.noise_level,
        "n_claims": len(d.claims),
        "n_members": len(d.members),
        "n_providers": len(d.providers),
        "period_start": iso(0),
        "period_end": iso(N_DAYS - 1),
        "generated_in_s": round(d.generated_in_s, 2),
        "detected_in_s": round(r.detect_in_s, 2),
        "total_billed": round(float(d.claims.billed_amount.sum()), 2),
        "read_only": state.read_only,
        "mode": state.mode,
    }


# ------------------------------------------------------------------ routes
@app.get("/health", response_model=Health)
def health() -> dict:
    r = state.current()
    return {
        "status": "ok",
        "mode": state.mode,
        "claims": len(r.dataset.claims),
        "alerts": len(r.alerts),
        "explain": "llm" if explainer is not None else "static",
    }


@app.get("/api/overview")
def overview() -> dict:
    r = state.current()
    per_scenario = []
    for s, meta in SCENARIOS.items():
        al = [a for a in r.alerts if a["scenario"] == s]
        per_scenario.append(
            {
                "scenario": s,
                "label": meta["label"],
                "alerts": len(al),
                "lines": sum(a["n_lines"] for a in al),
                "amount": round(sum(a["amount"] for a in al), 2),
                "by_severity": {sev: sum(1 for a in al if a["severity"] == sev) for sev in ("haute", "moyenne", "faible")},
            }
        )
    per_day = [{"date": iso(d), **{f"s{s}": 0 for s in SCENARIOS}} for d in range(N_DAYS)]
    for a in r.alerts:
        per_day[a["alert_day"]][f"s{a['scenario']}"] += 1
    return {
        "dataset": _dataset_meta(),
        "totals": {
            "alerts": len(r.alerts),
            "alerts_per_day": round(len(r.alerts) / N_DAYS, 2),
            "high_severity": sum(1 for a in r.alerts if a["severity"] == "haute"),
            "flagged_amount": round(sum(a["amount"] for a in r.alerts), 2),
        },
        "per_scenario": per_scenario,
        "per_day": per_day,
        "scenarios": {str(k): v["label"] for k, v in SCENARIOS.items()},
        "decisions": DECISIONS,
        "rules": rules_doc(),
        "by_decision": _by_decision(r.alerts),
        "top_providers": _top_providers(r),
        "recent_high": _recent_high(r.alerts),
        "highlights": _highlights(r),
    }


def _recent_high(alerts: list[dict], n: int = 6) -> list[dict]:
    high = [a for a in alerts if a["severity"] == "haute"]
    return [_summary(a) for a in sorted(high, key=lambda a: (-a["alert_day"], a["id"]))[:n]]


def _by_decision(alerts: list[dict]) -> list[dict]:
    rows = []
    for key, label in DECISIONS.items():
        al = [a for a in alerts if a["decision"] == key]
        if al:
            rows.append({"decision": key, "label": label, "alerts": len(al), "amount": round(sum(a["amount"] for a in al), 2)})
    return sorted(rows, key=lambda x: -x["alerts"])


def _top_providers(r, n: int = 6) -> list[dict]:
    ptype = dict(zip(r.dataset.providers.provider_id, r.dataset.providers.provider_type, strict=True))
    agg: dict[str, dict] = {}
    for a in r.alerts:
        p = a["provider_id"]
        if p is None:
            continue
        empty = {"provider_id": p, "type": PROVIDER_TYPES[ptype[p]], "alerts": 0, "amount": 0.0, "scenarios": set()}
        row = agg.setdefault(p, empty)
        row["alerts"] += 1
        row["amount"] += a["amount"]
        row["scenarios"].add(a["scenario"])
    top = sorted(agg.values(), key=lambda x: (-x["alerts"], x["provider_id"]))[:n]
    return [{**x, "amount": round(x["amount"], 2), "scenarios": sorted(x["scenarios"])} for x in top]


def _highlights(r) -> dict:
    """One key number per view, for the overview page. Parts still computing are None."""
    ev = r.evaluation["overall"]
    out: dict = {
        "recall": ev["recall_any"],
        "precision": ev["precision_any"],
        "false_alerts_per_day": ev["false_alerts_per_day"],
        "caught_amount_share": round(ev["caught_amount"] / ev["fraud_amount"], 3) if ev["fraud_amount"] else None,
    }
    sig = r.get_exploration()["signals"]["price"]
    out["price_signal"] = {
        "fraud": sig["fraud_rule_share"],
        "legit": sig["legit_rule_share"],
        "threshold": sig["threshold_label"],
    }
    card = r.get_providers()["scorecard"]
    out["complicit"] = {"in_top": card["complicit_in_top"], "total": card["complicit_total"]}
    adv = r.advanced if r.advanced and "error" not in r.advanced else None
    if adv:
        g = adv["gain"]
        cap = min(g["alerts"], g["days"])

        def at(name: str) -> float:
            pts = g["curves"][name]["amount"]
            return next((p["y"] for p in pts if p["k"] >= cap), pts[-1]["y"])

        out["gain"] = {
            "capacity": cap,
            "amount_order": at("amount"),
            "severity_order": at("severity_amount"),
            "arrival_order": at("chronological"),
        }
    m = r.model if r.model and "error" not in r.model else None
    if m:
        out["model"] = {
            "rules": m["rules"]["recall"],
            "metier": m["models"]["metier"]["at_budget"]["recall"],
            "brutes": m["models"]["brutes"]["at_budget"]["recall"],
            "model_only": m["overlap"]["fraud_model_only"],
        }
    return out


@app.get("/api/alerts", response_model=AlertPage)
def list_alerts(
    scenario: int | None = Query(None, ge=1, le=5),
    severity: Literal["haute", "moyenne", "faible"] | None = None,
    decision: str | None = None,
    q: str | None = Query(None, max_length=40, description="Adhérent ou prestataire (ex. M00012, P0031)"),
    date_from: date | None = None,
    date_to: date | None = None,
    sort: Literal["date", "score", "amount", "severity"] = "date",
    order: Literal["asc", "desc"] = "desc",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
) -> dict:
    if decision is not None and decision not in DECISIONS:
        raise HTTPException(422, "décision inconnue")
    items = state.current().alerts
    if scenario is not None:
        items = [a for a in items if a["scenario"] == scenario]
    if severity is not None:
        items = [a for a in items if a["severity"] == severity]
    if decision is not None:
        items = [a for a in items if a["decision"] == decision]
    if q:
        needle = q.strip().upper()
        items = [a for a in items if needle in a["member_id"] or needle in (a["provider_id"] or "") or needle in a["id"]]
    if date_from is not None:
        items = [a for a in items if a["alert_day"] >= day_of(date_from)]
    if date_to is not None:
        items = [a for a in items if a["alert_day"] <= day_of(date_to)]
    sev_rank = {"haute": 3, "moyenne": 2, "faible": 1}
    keys = {
        "date": lambda a: (a["alert_day"], a["id"]),
        "score": lambda a: (a["score"], a["id"]),
        "amount": lambda a: (a["amount"], a["id"]),
        "severity": lambda a: (sev_rank[a["severity"]], a["score"]),
    }
    items = sorted(items, key=keys[sort], reverse=order == "desc")
    total = len(items)
    pages = max(1, math.ceil(total / page_size))
    chunk = items[(page - 1) * page_size : page * page_size]
    return {"total": total, "page": page, "page_size": page_size, "pages": pages, "items": [_summary(a) for a in chunk]}


@app.get("/api/alerts/{alert_id}", response_model=AlertDetail)
def alert_detail(alert_id: str) -> dict:
    r = state.current()
    a = r.alerts_by_id.get(alert_id)
    if a is None:
        raise HTTPException(404, "alerte introuvable")
    claims = r.claims_by_line
    flagged, context = set(a["line_ids"]), a["context_line_ids"]
    rows = claims.loc[sorted(flagged | set(context))].sort_values(["day", "line_id"])
    evidence = [
        {
            "line_id": int(x.line_id),
            "date": iso(x.day),
            "role": "signalée" if x.line_id in flagged else "contexte",
            "member_id": x.member_id,
            "provider_id": x.provider_id,
            "provider_type": PROVIDER_TYPES[x.provider_type],
            "act_code": x.act_code,
            "act_label": ACTS[x.act_code].label,
            "diagnosis_code": x.diagnosis_code,
            "diagnosis_label": DIAGNOSES[x.diagnosis_code],
            "billed_amount": float(x.billed_amount),
        }
        for x in rows.itertuples(index=False)
    ]
    chart = None
    if a["scenario"] == 1:
        line = claims.loc[a["line_ids"][0]]
        history = price_history(r.dataset.claims, line.act_code, int(line.day))
        chart = {
            "act_label": ACTS[line.act_code].label,
            "past": [{"date": iso(p["day"]), "amount": p["amount"]} for p in history],
            "reference_median": a["details"]["reference_median"],
            "claim": {"date": iso(int(line.day)), "amount": float(line.billed_amount)},
        }
    truth_rows = claims.loc[a["line_ids"]]
    labels = sorted({int(v) for v in truth_rows.fraud_scenario})
    notes = sorted({n for n in truth_rows.fraud_note if n})
    oddities = sorted({n for n in truth_rows.legit_oddity if n})
    return {
        **_summary(a),
        "details": a["details"],
        "evidence": evidence,
        "chart": chart,
        "ground_truth": {
            "injected_scenarios": [s for s in labels if s],
            "is_fraud": any(labels),
            "notes": notes,
            "legit_oddities": oddities,
        },
    }


@app.get("/api/evaluation")
def evaluation() -> dict:
    r = state.current()
    ev = r.evaluation
    return {
        "dataset": _dataset_meta(),
        "per_scenario": ev["per_scenario"],
        "overall": ev["overall"],
        "false_alert_causes": ev["false_alert_causes"],
        "per_day": [{"date": iso(p["day"]), "alerts": p["alerts"], "false_alerts": p["false_alerts"]} for p in ev["per_day"]],
        "noise_curve": state.curve(r.dataset.seed, r.dataset.size),
    }


@app.get("/api/evaluation/advanced")
def evaluation_advanced() -> dict:
    r = state.current()
    adv = r.advanced
    if adv is None:
        return {"status": "computing"}
    if "error" in adv:
        return {"status": "error", "error": adv["error"]}
    return {"status": "ready", "dataset": _dataset_meta(), **adv}


@app.get("/api/providers")
def providers_view() -> dict:
    r = state.current()
    return {"dataset": _dataset_meta(), **r.get_providers()}


@app.get("/api/model")
def model_view() -> dict:
    r = state.current()
    m = r.model
    if m is None:
        return {"status": "computing"}
    if "error" in m:
        return {"status": "error", "error": m["error"]}
    return {"status": "ready", "dataset": _dataset_meta(), **m}


@app.get("/api/explain")
def explain() -> dict:
    """« Lecture IA » commentaries for the charts (static provider; see app/narratives.py).

    ``dynamic`` tells the page whether /api/explain/{chart_id} asks a language model on the server.
    """
    r = state.current()
    return {"dataset": _dataset_meta(), "dynamic": explainer is not None, **r.get_narratives()}


@app.get("/api/explain/{chart_id}")
def explain_one(chart_id: str) -> dict:
    """One chart's reading: the server-side model's when configured and checked, else the static one."""
    r = state.current()
    narratives = r.get_narratives()
    item = narratives["items"].get(chart_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Pas de commentaire pour ce graphique.")
    if explainer is not None:
        d = r.dataset
        dynamic = explainer.explain(f"{d.seed}-{d.size}-{d.noise_level}", item)
        if dynamic is not None:
            return {"item": dynamic, "source": explainer.source, "fallback": False}
    return {"item": item, "source": narratives["source"], "fallback": explainer is not None}


@app.get("/api/exploration")
def exploration() -> dict:
    r = state.current()
    return {"dataset": _dataset_meta(), **r.get_exploration()}


@app.post("/api/regenerate")
def regenerate(body: RegenerateRequest, request: Request) -> JSONResponse:
    from app.state import limiter

    if state.read_only:
        return JSONResponse(
            {"detail": "La régénération est désactivée sur la démo en ligne. Elle fonctionne en local : voir le README."},
            status_code=403,
        )
    client = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
        request.client.host if request.client else "inconnu"
    )
    wait = limiter.check(client)
    if wait > 0:
        return JSONResponse(
            {"detail": f"Trop de demandes. Réessayez dans {math.ceil(wait)} s."},
            status_code=429,
            headers={"Retry-After": str(math.ceil(wait))},
        )
    result = state.try_regenerate(body.seed, body.size, body.noise_level)
    if result is None:
        return JSONResponse({"detail": "Une régénération est déjà en cours."}, status_code=429, headers={"Retry-After": "5"})
    state.curve(body.seed, body.size)
    return JSONResponse({"dataset": _dataset_meta(), "alerts": len(result.alerts)})


# ------------------------------------------------------------------ static
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index() -> HTMLResponse:
    # no-transform: CDN proxies (Cloudflare Rocket Loader, email obfuscation, analytics beacon) must not
    # rewrite this page; it is small, so losing edge compression on it costs nothing.
    return HTMLResponse(INDEX_HTML, headers={"Cache-Control": "no-cache, no-transform"})
