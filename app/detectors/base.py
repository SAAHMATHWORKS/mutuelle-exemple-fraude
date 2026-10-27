"""Shared structures for the scenario detectors."""

from __future__ import annotations

from dataclasses import dataclass, field

SEVERITY_ORDER = {"haute": 3, "moyenne": 2, "faible": 1}


@dataclass
class Alert:
    """One alert as a claims handler sees it.

    ``line_ids`` are the claim lines the alert accuses; ``context_line_ids``
    are extra rows shown as evidence (for example the original invoice of a
    duplicate) but not counted as flagged.
    """

    scenario: int
    severity: str
    score: float
    alert_day: int
    member_id: str
    provider_id: str | None
    line_ids: list[int]
    reason: str
    decision: str
    details: dict = field(default_factory=dict)
    context_line_ids: list[int] = field(default_factory=list)


def euros(x: float) -> str:
    """French money formatting: 1 234,50 €."""
    s = f"{x:,.2f}".replace(",", " ").replace(".", ",")
    return f"{s} €"
