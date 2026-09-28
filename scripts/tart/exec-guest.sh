#!/bin/bash
# Host-side. tart exec with retry: the guest agent's control socket drops
# intermittently when the guest is loaded. Usage: exec-guest.sh <vm> <script-file> [attempts]
VM="$1"; SCRIPT="$2"; N=${3:-6}
for i in $(seq 1 "$N"); do
  OUT=$(tart exec -i "$VM" /bin/bash -s < "$SCRIPT" 2>&1)
  if ! printf '%s' "$OUT" | grep -q "Failed to connect to the VM using its control socket"; then
    printf '%s\n' "$OUT"; exit 0
  fi
  sleep 10
done
printf '%s\n' "$OUT"; exit 1
