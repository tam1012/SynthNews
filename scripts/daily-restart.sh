#!/bin/bash
set -e

APP_CONTAINER="newstamhv-app"
HEALTH_CHECK_URL="http://127.0.0.1:3001/api/health/live"
MAX_ATTEMPTS=12 # 12 attempts * 10 seconds = 2 minutes timeout
ATTEMPT_DELAY=10
NOTIFY_SCRIPT="/home/ubuntu/automation/hermes/scripts/openclaw_notify.py"

echo "[$(date)] Bat dau khoi dong lai dinh ky cho $APP_CONTAINER..."

# 1. Thuc hien restart
docker compose -f /home/ubuntu/newstamhv/docker-compose.yml restart app

# 2. Vong lap kiem tra suc khoe
success=false
for ((i=1; i<=MAX_ATTEMPTS; i++)); do
  echo "Kiem tra suc khoe (lan $i/$MAX_ATTEMPTS)..."
  
  # Lay trang thai tu docker inspect
  health_status=$(docker inspect --format='{{.State.Health.Status}}' $APP_CONTAINER 2>/dev/null || echo "unknown")
  
  if [ "$health_status" = "healthy" ]; then
    # Kiem tra cong HTTP phan hoi 200 OK
    if curl -fsS "$HEALTH_CHECK_URL" >/dev/null; then
      echo "Container $APP_CONTAINER da khoi dong lai va hoat dong binh thuong!"
      success=true
      break
    fi
  fi
  
  sleep $ATTEMPT_DELAY
done

# 3. Xu ly khi that bai
if [ "$success" = "false" ]; then
  msg="[CANH BAO] SynthNews app restart that bai hoac khong phan hoi sau 2 phut! Dang thu khoi phuc..."
  echo "$msg"
  if [ -f "$NOTIFY_SCRIPT" ]; then
    python3 "$NOTIFY_SCRIPT" --message "$msg" --channels telegram
  fi
  
  # Thu khoi phuc bang cach recreate cung container
  docker compose -f /home/ubuntu/newstamhv/docker-compose.yml up -d --force-recreate app
  
  sleep 20
  
  # Kiem tra lai lan cuoi
  health_status=$(docker inspect --format='{{.State.Health.Status}}' $APP_CONTAINER 2>/dev/null || echo "unknown")
  if [ "$health_status" = "healthy" ] && curl -fsS "$HEALTH_CHECK_URL" >/dev/null; then
    msg="[OK] SynthNews da khoi phuc thanh cong sau khi recreate container."
    echo "$msg"
    if [ -f "$NOTIFY_SCRIPT" ]; then
      python3 "$NOTIFY_SCRIPT" --message "$msg" --channels telegram
    fi
    exit 0
  else
    msg="[NGUY HIEM] SynthNews khoi phuc that bai! Website hien dang khong the truy cap."
    echo "$msg"
    if [ -f "$NOTIFY_SCRIPT" ]; then
      python3 "$NOTIFY_SCRIPT" --message "$msg" --channels telegram
    fi
    exit 1
  fi
fi
