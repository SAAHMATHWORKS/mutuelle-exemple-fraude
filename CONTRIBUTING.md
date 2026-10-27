# Contributing

## Ground rule: synthetic data only

Everything in this repository is invented: the insurer, members, providers, codes, prices and fraud.
Never add real data, real names, real thresholds or code taken from an employer or a client.
If in doubt, leave it out.

## Set up

Python 3.12 is required (the versions in `requirements*.txt` are pinned for it).

```bash
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 7860
```

Set `DEMO_SIZE=4000` for a faster start while developing (see `.env.example`).

## Before you push

```bash
ruff check . && ruff format --check .
pytest
```

The CI runs the same commands, starts the app, then builds the Docker image and runs it
read-only, as a non-root user, with 512 MB of memory and 1 CPU. A change that breaks any of
these does not go to the server.

## Conventions

- Code, comments and README in English; everything a user sees in the interface in French.
- One detector module per fraud scenario in `app/detectors/`. Rules and simple statistics only:
  every alert must say why it exists, show its evidence rows and suggest a decision.
- A detector may only use information available on the claim's date. The price reference uses
  claims dated strictly before; `tests/test_no_lookahead.py` guards this.
- The front end has no build step: plain HTML, CSS and JavaScript, with Chart.js vendored in
  `app/static/vendor/`. Nothing is loaded from a CDN at runtime.
- Pin every new dependency to an exact version in `requirements.txt` or `requirements-dev.txt`.
