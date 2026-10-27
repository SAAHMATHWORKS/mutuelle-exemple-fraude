import os

import pytest

# Small dataset for the API tests; must be set before the app is imported.
os.environ.setdefault("DEMO_SIZE", "4000")

from app.generator import generate
from app.pipeline import run


@pytest.fixture(scope="session")
def low_noise_result():
    return run(generate(seed=42, size=20_000, noise_level=0.0))


@pytest.fixture(scope="session")
def high_noise_result():
    return run(generate(seed=42, size=20_000, noise_level=1.0))
