# Mutuelle Exemple — scenario-based fraud detection demo (synthetic data only).
# Works on Hugging Face Spaces (port 7860) and on Render (reads $PORT).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=7860

# Hugging Face Spaces runs containers as uid 1000; use the same user everywhere.
RUN useradd --create-home --uid 1000 app
WORKDIR /home/app/demo

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY --chown=app:app app ./app

USER app
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"7860\")}/health', timeout=4)"

# Shell form so that $PORT is expanded at start-up. One worker: the dataset lives in memory.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860} --workers 1 --proxy-headers --forwarded-allow-ips "*"
