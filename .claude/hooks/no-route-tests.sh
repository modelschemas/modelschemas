#!/bin/sh
# Block test files under src/routes: the TanStack router treats them as
# routes. Test the code a route calls (src/server, src/lib) instead.
path=$(jq -r '.tool_input.file_path // empty')
case "$path" in
  */src/routes/*.test.ts | */src/routes/*.test.tsx)
    echo "No tests under src/routes ($path): the router picks them up as routes. Move the logic into src/server or src/lib and test it there." >&2
    exit 2 ;;
esac
