# Mutuelle Exemple — scenario-based fraud detection demo (synthetic data only).
#
# Stage 1 installs the pinned dependencies in a virtual environment and builds the
# showcase snapshot: every view computed once (about 20 s and 300 MB of RAM, at build
# time only). Stage 2 copies what runs. The container then serves the snapshot
# read-only: instant answers, about 110 MB of RAM, nothing computed per visitor.
#
# Live mode (regeneration on): run with an empty DEMO_SNAPSHOT, e.g.
#   docker run -e DEMO_SNAPSHOT= -p 7860:7860 mutuelle-exemple-fraude
# Works on Hugging Face Spaces (port 7860) and on Render (reads $PORT).

FROM python:3.12-slim AS build
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/opt/venv/bin:$PATH
RUN python -m venv /opt/venv
WORKDIR /src
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app ./app
RUN python -m app.snapshot /opt/snapshot/demo.pkl.gz


FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    PORT=7860 \
    DEMO_SNAPSHOT=/opt/snapshot/demo.pkl.gz

# Hugging Face Spaces runs containers as uid 1000; use the same user everywhere.
RUN useradd --create-home --uid 1000 app
WORKDIR /home/app/demo

COPY --from=build /opt/venv /opt/venv
COPY --from=build /opt/snapshot /opt/snapshot
COPY --chown=app:app app ./app
# Bytecode compiled now, so a read-only container starts without writing anything.
RUN python -m compileall -q app

USER app
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"7860\")}/health', timeout=4)"

# Shell form so that $PORT is expanded at start-up. One worker: the dataset lives in memory.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860} --workers 1 --proxy-headers --forwarded-allow-ips "*"
