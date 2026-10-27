"""« Lecture IA » must never quote a number the chart does not hold."""

import re

import pytest

from app.generator import generate
from app.narratives import SOURCE, build
from app.pipeline import run
from app.state import AppState

EXPECTED = {
    "volume",
    "sev",
    "dec",
    "amounts",
    "mix",
    "spread",
    "season",
    "daily",
    "lorenz",
    "age",
    "sig-price",
    "sig-dup",
    "sig-prov",
    "sig-early",
    "sig-coh",
    "hm",
    "sc",
    "net",
    "per",
    "causes",
    "pr",
    "cm",
    "gain",
    "sevcal",
    "m-recall",
    "m-pr",
    "m-overlap",
}


@pytest.fixture(scope="module")
def narratives():
    r = run(generate())
    AppState._compute_advanced(r)
    return build(r)


def test_every_chart_has_a_complete_commentary(narratives):
    assert narratives["source"] == SOURCE
    items = narratives["items"]
    assert set(items) == EXPECTED
    for key, it in items.items():
        assert it["id"] == key
        for part in ("title", "see", "why", "limit"):
            assert isinstance(it[part], str) and it[part], (key, part)
        for part in ("see", "why", "limit"):
            assert len(it[part]) > 20, (key, part)
        assert it["facts"], key


def test_no_number_outside_the_recorded_facts(narratives):
    for key, it in narratives["items"].items():
        text = " ".join((it["see"], it["why"], it["limit"]))
        for fact in sorted(set(it["facts"]), key=len, reverse=True):
            assert fact in text, (key, fact)  # every listed fact is actually used
            text = text.replace(fact, " ")
        stray = re.findall(r"\d+", text)
        assert not stray, f"{key}: number(s) {stray} not taken from the data"


def test_commentaries_follow_the_data():
    a = run(generate(seed=42))
    b = run(generate(seed=7))
    for r in (a, b):
        AppState._compute_advanced(r)
    fa, fb = build(a)["items"], build(b)["items"]
    assert any(fa[k]["facts"] != fb[k]["facts"] for k in fa)
