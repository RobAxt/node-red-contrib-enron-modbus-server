FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

# Utilidades básicas para red/debug
RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*
