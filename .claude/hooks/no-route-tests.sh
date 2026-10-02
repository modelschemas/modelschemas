#!/bin/sh
# Block test files under src/routes: the TanStack router treats them as
# routes. Test the code a route calls (src/server, src/lib) instead.
# Fails closed: without jq or with unreadable input, the write is refused.
command -v jq >/dev/null || { echo "no-route-tests: jq is not installed, cannot check the path" >&2; exit 2; }
path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty') ||
  { echo "no-route-tests: unreadable hook input" >&2; exit 2; }
case "$path" in
  src/routes/*.test.* | src/routes/*.spec.* | */src/routes/*.test.* | */src/routes/*.spec.*)
    echo "No tests under src/routes ($path): the router picks them up as routes. Move the logic into src/server or src/lib and test it there." >&2
    exit 2 ;;
esac
