#!/bin/sh

set -eu

# containerboot's healthz only establishes that the local daemon has an IP.
# An evicted node can retain its IP and BackendState=Running while disconnected
# from the control plane. Exclude peers so their Online flags cannot mask Self.
wget -q --spider http://127.0.0.1:9002/healthz
status=$(tailscale status --json --peers=false) || exit 1
printf '%s\n' "$status" | grep -Eq '^[[:space:]]*"BackendState": "Running",?$'
printf '%s\n' "$status" | grep -Eq '^[[:space:]]*"Online": true,?$'
