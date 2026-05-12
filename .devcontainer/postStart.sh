#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

USER_DIR="${NR_USER_DIR:-$HOME/.node-red-enron-modbus-server}"
RUNTIME_DIR=".devcontainer/.runtime"
PID_FILE="$RUNTIME_DIR/.nodered.pid"
LOG_FILE="$RUNTIME_DIR/.nodered.log"
RUNNER_CMD='nodemon'

mkdir -p "$RUNTIME_DIR"
mkdir -p "$USER_DIR"

# Avoid launching duplicates when container restarts or VS Code reconnects.
if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" >/dev/null 2>&1; then
    CMDLINE="$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
    if [[ "$CMDLINE" == *"$RUNNER_CMD"* ]]; then
      echo "[postStart] Node-RED ya esta ejecutandose con nodemon (PID $PID)."
      exit 0
    fi

    echo "[postStart] Detectada instancia legacy (PID $PID). Reiniciando con nodemon..."
    kill "$PID" >/dev/null 2>&1 || true
  fi
fi

echo "[postStart] Iniciando Node-RED con nodemon en segundo plano (puerto 1880)..."
nohup env NR_USER_DIR="$USER_DIR" npm run dev:nodered >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

echo "[postStart] Node-RED (nodemon) iniciado (PID $(cat "$PID_FILE"))."
echo "[postStart] Logs: tail -f $LOG_FILE"
