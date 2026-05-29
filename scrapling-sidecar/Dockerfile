FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget gnupg ca-certificates fonts-liberation \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libasound2 libpango-1.0-0 libcairo2 libx11-xcb1 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && scrapling install

COPY app/ ./app/

EXPOSE 8000

# One uvicorn worker by default. Each worker runs its own ThreadPool of browser
# launches; multiplying workers multiplies the live Camoufox processes and was a
# key driver of the PID/CPU blowup. Override with SCRAPLING_WORKERS if needed.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${SCRAPLING_WORKERS:-1}"]
