#!/bin/sh
set -e

for APP_DIR in "/opt/Agent Remote" "/opt/agent-remote"; do
  if [ -f "$APP_DIR/resources/bin/ar" ]; then
    chmod 0755 "$APP_DIR/resources/bin/ar" "$APP_DIR/resources/bin/agent-remote" || true
    mkdir -p /usr/local/bin
    ln -sf "$APP_DIR/resources/bin/ar" /usr/local/bin/ar
    ln -sf "$APP_DIR/resources/bin/agent-remote" /usr/local/bin/agent-remote
    break
  fi
done
