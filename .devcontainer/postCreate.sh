#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_DIR="${NR_USER_DIR:-$HOME/.node-red-enron-modbus-server}"
LEGACY_USER_DIR="$ROOT_DIR/.node-red"
PACKAGE_NAME="@axt/node-red-contrib-enron-modbus-server"

echo "[postCreate] Preparando dependencias del workspace..."
npm install

# Cleanup legacy in-repo userDir layout to prevent recursive nesting on fresh starts.
if [[ -d "$LEGACY_USER_DIR" ]]; then
  echo "[postCreate] Detectado userDir legacy en el repo ($LEGACY_USER_DIR). Limpiando..."
  rm -rf "$LEGACY_USER_DIR"
fi

mkdir -p "$USER_DIR"

if [[ ! -f "$USER_DIR/package.json" ]]; then
  npm --prefix "$USER_DIR" init -y >/dev/null 2>&1
fi

echo "[postCreate] Instalando Node-RED en userDir local..."
npm --prefix "$USER_DIR" install --no-audit --no-fund node-red@^4

echo "[postCreate] Enlazando el paquete local para debug en vivo..."
# Create the scoped directory structure if it doesn't exist
mkdir -p "$USER_DIR/node_modules/@axt"
# Create a symlink to the package root directory instead of using npm link
ln -sf "$ROOT_DIR" "$USER_DIR/node_modules/@axt/node-red-contrib-enron-modbus-server"

echo "[postCreate] Listo."
echo "[postCreate] Para auto-reload: ejecuta 'Node-RED: Auto Reload (Nodemon)' y luego 'Node-RED: Attach (9229)'."
