# Demo System Under Test (Orders Platform) — e2e/CI only, never shipped.
#
# The e2e suite creates a Traceo "environment" pointing at this app and the
# BACKEND (run executor) calls it over the compose network as http://sut:9000.
# Nothing else talks to it, so the port is not published to the host.

FROM python:3.14-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN useradd -u 10001 -m sut
WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY main.py ./
USER sut
EXPOSE 9000

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9000/health').status==200 else 1)"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9000"]
