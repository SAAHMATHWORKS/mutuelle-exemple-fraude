"""Static checks on the front end that guard against regressions found in production."""

from pathlib import Path

APP_JS = (Path(__file__).resolve().parents[1] / "app" / "static" / "app.js").read_text(encoding="utf-8")


def test_chart_animation_defaults_are_tuned_not_replaced():
    # Replacing Chart.defaults.animation drops the "type" of animated colours: the first hover then
    # throws inside Chart.js's shared animation loop and every later chart stays blank until a reload.
    code = "\n".join(line for line in APP_JS.splitlines() if not line.strip().startswith("//"))
    assert "Chart.defaults.animation =" not in code
    assert "Chart.defaults.animation.duration =" in code
