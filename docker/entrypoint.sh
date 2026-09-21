#!/bin/sh
# Container entrypoint for the Perch Network Controller.
#  1. APP_KEY: use the one given, else generate once and keep it in the data
#     volume so sessions and encrypted collector keys survive restarts.
#  2. Wait for the database by retrying the migrations, then run them.
#  3. Hand over to the server (CMD).
set -eu

# PERCH_* knobs; the METRICSLITE_* names of earlier images still work.
DATA_DIR="${PERCH_DATA_DIR:-${METRICSLITE_DATA_DIR:-/data}}"
mkdir -p "$DATA_DIR"

if [ -z "${APP_KEY:-}" ]; then
  if [ ! -s "$DATA_DIR/app_key" ]; then
    umask 077
    node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" > "$DATA_DIR/app_key"
    umask 022
    echo "perch: generated APP_KEY at $DATA_DIR/app_key"
  fi
  APP_KEY="$(cat "$DATA_DIR/app_key")"
  export APP_KEY
fi

attempt=0
max_attempts="${PERCH_DB_WAIT_ATTEMPTS:-${METRICSLITE_DB_WAIT_ATTEMPTS:-45}}"
until node ace migration:run --force; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "perch: database at ${DB_HOST:-db}:${DB_PORT:-3306} not ready after $max_attempts attempts, giving up" >&2
    exit 1
  fi
  echo "perch: waiting for the database ($attempt/$max_attempts)"
  sleep 2
done

exec "$@"
