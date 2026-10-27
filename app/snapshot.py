"""Showcase ("vitrine") snapshot: compute everything once, serve it read-only.

On a small shared server, the demo must answer instantly and never compete with
other services. ``python -m app.snapshot <path>`` runs at image build time: it
generates the default dataset, runs the rules, the exploration, the provider
analysis, the threshold sweeps, the Isolation Forest and the noise curve, then
writes the result to a compressed pickle. At run time, ``DEMO_SNAPSHOT=<path>``
makes the app load that file instead of computing anything, and turns
regeneration off.

The file is produced by this code inside the image build and never comes from
outside, which is the only case where loading a pickle is safe.
"""

from __future__ import annotations

import gzip
import logging
import pickle
import sys
import time
from pathlib import Path

from app.generator import DEFAULT_SEED, DEFAULT_SIZE, generate
from app.pipeline import run
from app.state import CURVE_MAX_SIZE, DEFAULT_NOISE, AppState

FORMAT_VERSION = 1
log = logging.getLogger(__name__)


def build(path: str | Path, seed: int = DEFAULT_SEED, size: int = DEFAULT_SIZE, noise_level: float = DEFAULT_NOISE) -> dict:
    """Compute every view of the demo and write it to ``path``. Returns timings."""
    t0 = time.perf_counter()
    result = run(generate(seed=seed, size=size, noise_level=noise_level))
    AppState._compute_advanced(result)  # threshold sweeps + Isolation Forest, synchronously
    for name, value in (("advanced", result.advanced), ("model", result.model)):
        if value is None or "error" in value:
            raise RuntimeError(f"snapshot: {name} failed: {value}")
    result.get_exploration()
    result.get_providers()
    curve = AppState().curve(seed, size, background=False)
    if curve.get("status") != "ready":
        raise RuntimeError(f"snapshot: noise curve failed: {curve}")
    payload = {
        "format": FORMAT_VERSION,
        "result": result,
        "curve": curve,
        "built_in_s": round(time.perf_counter() - t0, 1),
    }
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wb", compresslevel=6) as f:
        pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)
    return {
        "built_in_s": payload["built_in_s"],
        "bytes": path.stat().st_size,
        "claims": len(result.dataset.claims),
        "alerts": len(result.alerts),
    }


def load(path: str | Path) -> dict:
    with gzip.open(path, "rb") as f:
        # Safe only because the file is built by build() above, inside our own image.
        payload = pickle.load(f)
    if payload.get("format") != FORMAT_VERSION:
        raise ValueError(f"snapshot format {payload.get('format')} is not {FORMAT_VERSION}")
    r = payload["result"]
    if r.advanced is None or r.model is None or r.exploration is None or r.providers is None:
        raise ValueError("snapshot is incomplete")
    payload["curve_key"] = (r.dataset.seed, min(r.dataset.size, CURVE_MAX_SIZE))
    return payload


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "snapshot/demo.pkl.gz"
    info = build(target)
    print(f"snapshot written to {target}: {info}")
