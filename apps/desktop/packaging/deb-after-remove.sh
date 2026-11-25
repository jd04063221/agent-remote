#!/bin/sh
set -e

for CMD in /usr/local/bin/ar /usr/local/bin/agent-remote; do
  if [ -L "$CMD" ]; then
    TARGET="$(readlink "$CMD" || true)"
    case "$TARGET" in
      "/opt/Agent Remote/"*|"/opt/agent-remote/"*)
        rm -f "$CMD"
        ;;
    esac
  fi
done
