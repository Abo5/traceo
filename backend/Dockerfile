# Traceo Python backend — FR-081 (on-premise deployment).
#
# The Python stack needs compiled wheels (pymupdf, argon2-cffi), so dependencies
# are installed in a builder stage and the resulting virtualenv is copied into a
# clean runtime image. That keeps compilers out of the shipped image, which
# matters for an on-premise security review (BR-07).

FROM python:3.14-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /src

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first: cached until requirements.txt actually changes.
COPY requirements.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install -r requirements.txt

FROM python:3.14-slim
RUN useradd -u 10001 -m traceo
WORKDIR /app

COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY app ./app
# Shipped so the container can bring the schema up to date before serving.
COPY alembic.ini ./
COPY migrations ./migrations
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Writable state lives here; mount a volume so data survives an image upgrade.
RUN mkdir -p /data/storage && chown -R traceo:traceo /data
USER traceo

ENV TRACEO_DATABASE_URL=sqlite:////data/traceo.db \
    TRACEO_STORAGE_DIR=/data/storage
EXPOSE 8000

# Deliberately NOT setting TRACEO_ENV=production here — see backend-go/Dockerfile
# for the reasoning; the same config guard applies to both backends.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
