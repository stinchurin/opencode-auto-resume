#!/bin/sh
# Test double for codex-limits: first probe reports the limit with a 2s resume
# window, every later probe reports it cleared. Counter lives in a state file.
STATE="${FAKE_LIMITS_STATE:-/Users/sergejtincurin/.local/share/opencode-v2-migration/tmp/fake-limits-state}"
N=0
[ -f "$STATE" ] && N=$(cat "$STATE" 2>/dev/null || echo 0)
N=$((N + 1))
echo "$N" > "$STATE"
NOW=$(date +%s)
if [ "$N" -le 1 ]; then
  echo "{\"ok\":true,\"limit_reached\":true,\"reset_at\":$((NOW + 60)),\"resume_at\":$((NOW + 2)),\"deciding_window\":\"5h\",\"grace_seconds\":0}"
else
  echo "{\"ok\":true,\"limit_reached\":false,\"reset_at\":null,\"resume_at\":null,\"grace_seconds\":0}"
fi
exit 0
