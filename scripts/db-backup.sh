#!/bin/bash
set -euo pipefail

# Backup dinh ky PostgreSQL cho SynthNews.
# Chay qua cron tren VPS (KHONG di qua docker build). Doc thang tu container db.
# Lich: 03:30 Asia/Ho_Chi_Minh (sau khi daily-restart.sh restart app luc 03:00 da xong).

DB_CONTAINER="newstamhv-db"
DB_USER="newstamhv"
DB_NAME="newstamhv"
BACKUP_DIR="/home/ubuntu/newstamhv/backups"
RETENTION_DAYS=14
LOCK_FILE="/tmp/synthnews_db_backup.lock"
NOTIFY_SCRIPT="/home/ubuntu/automation/hermes/scripts/openclaw_notify.py"
KUMA_PUSH="/home/ubuntu/bin/kuma-push"
KUMA_ID="${SYNTHNEWS_BACKUP_KUMA_ID:-}"   # set neu muon day heartbeat len Uptime Kuma

timestamp() { date '+%Y-%m-%d_%H%M%S'; }

notify_fail() {
  local msg="$1"
  echo "[$(date)] $msg"
  if [ -f "$NOTIFY_SCRIPT" ]; then
    python3 "$NOTIFY_SCRIPT" --message "$msg" --channels telegram || true
  fi
  if [ -n "$KUMA_ID" ] && [ -x "$KUMA_PUSH" ]; then
    "$KUMA_PUSH" "$KUMA_ID" down "$msg" || true
  fi
}

# Chay don luong, tranh chong cheo neu lan truoc chua xong.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date)] Mot tien trinh backup khac dang chay, bo qua lan nay."
  exit 0
fi

mkdir -p "$BACKUP_DIR"

OUT_FILE="$BACKUP_DIR/synthnews_$(timestamp).sql.gz"
TMP_FILE="$OUT_FILE.partial"

echo "[$(date)] Bat dau backup DB '$DB_NAME' -> $OUT_FILE"

# 1. Dump + nen. pg_dump that bai (PIPESTATUS[0]) thi coi nhu loi.
if ! docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" 2>/dev/null | gzip -c > "$TMP_FILE"; then
  rm -f "$TMP_FILE"
  notify_fail "[BACKUP LOI] SynthNews: pg_dump that bai, khong tao duoc backup."
  exit 1
fi
if [ "${PIPESTATUS[0]}" -ne 0 ]; then
  rm -f "$TMP_FILE"
  notify_fail "[BACKUP LOI] SynthNews: pg_dump tra ve loi, khong tao duoc backup."
  exit 1
fi

# 2. Kiem tra file dump khong rong va giai nen duoc (gzip con nguyen).
if [ ! -s "$TMP_FILE" ] || ! gzip -t "$TMP_FILE" 2>/dev/null; then
  rm -f "$TMP_FILE"
  notify_fail "[BACKUP LOI] SynthNews: file backup rong hoac hong (gzip -t fail)."
  exit 1
fi

mv "$TMP_FILE" "$OUT_FILE"
SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "[$(date)] Backup OK: $OUT_FILE ($SIZE)"

# 3. Don file cu hon RETENTION_DAYS ngay.
DELETED=$(find "$BACKUP_DIR" -name 'synthnews_*.sql.gz' -type f -mtime +"$RETENTION_DAYS" -print -delete | wc -l)
echo "[$(date)] Da xoa $DELETED backup cu hon $RETENTION_DAYS ngay."

# 4. Bao Kuma OK neu co cau hinh.
if [ -n "$KUMA_ID" ] && [ -x "$KUMA_PUSH" ]; then
  "$KUMA_PUSH" "$KUMA_ID" up "SynthNews DB backup OK ($SIZE)" || true
fi

echo "[$(date)] Hoan tat."
