FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    BLOOM_HOST=0.0.0.0 \
    BLOOM_PORT=8080

WORKDIR /app
COPY . .

# run as an unprivileged user; bookings live in the /app/data volume
RUN useradd --system --uid 10001 bloom \
 && mkdir -p /app/data \
 && chown bloom /app/data
USER bloom
VOLUME ["/app/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/config', timeout=3)"

CMD ["python", "server.py"]
