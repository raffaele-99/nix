FROM python:3.14-slim-bookworm

WORKDIR /app

RUN python -m pip install --no-cache-dir uv==0.12.17

COPY pyproject.toml uv.lock README.md .python-version ./
COPY src/ src/

RUN uv sync --frozen --no-dev --no-editable

ENTRYPOINT ["/app/.venv/bin/scanhaus"]
