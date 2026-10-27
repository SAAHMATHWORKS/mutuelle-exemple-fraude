"""In-memory application state: the current dataset, its alerts, and the
noise curve (performance at several noise levels), computed in background.

In showcase mode (``DEMO_SNAPSHOT`` points to a file built by ``app.snapshot``)
everything is loaded precomputed at startup and regeneration is turned off.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque

from app.advanced_eval import advanced
from app.generator import DEFAULT_SEED, DEFAULT_SIZE, generate
from app.model_compare import compare
from app.pipeline import Result, run

CURVE_LEVELS = (0.0, 0.25, 0.5, 0.75, 1.0)
CURVE_MAX_SIZE = 20_000
DEFAULT_NOISE = 0.2

# Optional overrides for the dataset built at startup (handy for tests or a small host).
START_SEED = int(os.environ.get("DEMO_SEED", DEFAULT_SEED))
START_SIZE = int(os.environ.get("DEMO_SIZE", DEFAULT_SIZE))
START_NOISE = float(os.environ.get("DEMO_NOISE", DEFAULT_NOISE))
SNAPSHOT_PATH = os.environ.get("DEMO_SNAPSHOT", "").strip()

log = logging.getLogger("app.state")


class AppState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._regen_lock = threading.Lock()
        self.result: Result | None = None
        self._curves: dict[tuple[int, int], dict] = {}
        self._curve_running: set[tuple[int, int]] = set()
        self.read_only = False  # True in showcase mode: no regeneration, nothing computed at run time
        self.mode = "live"

    def use_snapshot(self, path: str) -> None:
        """Serve a precomputed snapshot (built by ``python -m app.snapshot``) instead of computing."""
        from app.snapshot import load as load_snapshot

        payload = load_snapshot(path)
        with self._lock:
            self.result = payload["result"]
            self._curves[payload["curve_key"]] = payload["curve"]
        self.read_only = True
        self.mode = "vitrine"

    # ----------------------------------------------------------- dataset
    def load(self, seed: int = START_SEED, size: int = START_SIZE, noise_level: float = START_NOISE) -> Result:
        result = run(generate(seed=seed, size=size, noise_level=noise_level))
        with self._lock:
            self.result = result
        # Threshold sweeps re-run every rule several times (a few seconds): never block a page on it.
        threading.Thread(target=self._compute_advanced, args=(result,), daemon=True).start()
        return result

    @staticmethod
    def _compute_advanced(result: Result) -> None:
        try:
            result.advanced = advanced(result.dataset.claims, result.refs, result.alerts)
        except Exception as exc:  # pragma: no cover - defensive
            result.advanced = {"error": str(exc)}
        try:
            result.model = compare(result.dataset, result.refs, result.alerts)
        except Exception as exc:  # pragma: no cover - defensive
            result.model = {"error": str(exc)}

    def current(self) -> Result:
        if self.result is None:
            return self.load()
        return self.result

    def try_regenerate(self, seed: int, size: int, noise_level: float) -> Result | None:
        """Regenerate unless another regeneration is already running (returns None)."""
        if not self._regen_lock.acquire(blocking=False):
            return None
        try:
            return self.load(seed, size, noise_level)
        finally:
            self._regen_lock.release()

    # ------------------------------------------------------- noise curve
    def curve(self, seed: int, size: int, background: bool = True) -> dict:
        key = (seed, min(size, CURVE_MAX_SIZE))
        with self._lock:
            if key in self._curves:
                return self._curves[key]
            running = key in self._curve_running
            if not running:
                self._curve_running.add(key)
        if not running:
            if background:
                threading.Thread(target=self._compute_curve, args=(key,), daemon=True).start()
            else:
                self._compute_curve(key)
                return self._curves[key]
        return {"status": "computing", "seed": key[0], "size": key[1], "levels": []}

    def _compute_curve(self, key: tuple[int, int]) -> None:
        seed, size = key
        t0 = time.perf_counter()
        levels = []
        try:
            for noise in CURVE_LEVELS:
                ev = run(generate(seed=seed, size=size, noise_level=noise)).evaluation
                levels.append(
                    {
                        "noise_level": noise,
                        "per_scenario": [
                            {k: p[k] for k in ("scenario", "label", "recall", "precision", "false_alerts_per_day")}
                            for p in ev["per_scenario"]
                        ],
                        "overall": {
                            k: ev["overall"][k] for k in ("recall_any", "precision_any", "alerts_per_day", "false_alerts_per_day")
                        },
                    }
                )
            data = {
                "status": "ready",
                "seed": seed,
                "size": size,
                "levels": levels,
                "computed_in_s": round(time.perf_counter() - t0, 1),
            }
        except Exception as exc:  # pragma: no cover - defensive
            data = {"status": "error", "seed": seed, "size": size, "levels": [], "error": str(exc)}
        with self._lock:
            self._curves[key] = data
            self._curve_running.discard(key)


class RateLimiter:
    """Small sliding-window limiter: per client and global."""

    def __init__(self, per_client_seconds: float = 15.0, global_per_minute: int = 6) -> None:
        self.per_client_seconds = per_client_seconds
        self.global_per_minute = global_per_minute
        self._last: dict[str, float] = {}
        self._recent: deque[float] = deque()
        self._lock = threading.Lock()

    def check(self, client: str) -> float:
        """Return 0 if allowed (and record it), otherwise seconds to wait."""
        now = time.monotonic()
        with self._lock:
            while self._recent and now - self._recent[0] > 60:
                self._recent.popleft()
            wait_client = self.per_client_seconds - (now - self._last.get(client, -1e9))
            wait_global = 60 - (now - self._recent[0]) if len(self._recent) >= self.global_per_minute else 0
            wait = max(wait_client, wait_global, 0)
            if wait > 0:
                return wait
            self._last[client] = now
            self._recent.append(now)
            if len(self._last) > 10_000:
                self._last.clear()
            return 0.0


state = AppState()
limiter = RateLimiter()

if SNAPSHOT_PATH:
    try:
        state.use_snapshot(SNAPSHOT_PATH)
        log.info("showcase mode: snapshot loaded from %s", SNAPSHOT_PATH)
    except Exception as exc:  # the site must still answer: fall back to computing live
        log.error("snapshot %s unusable (%s); falling back to live mode", SNAPSHOT_PATH, exc)
