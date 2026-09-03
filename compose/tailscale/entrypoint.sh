#!/bin/sh

set -eu

case "${TS_FORWARD_MSS:-}" in
  "" | *[!0-9]*)
    echo "TS_FORWARD_MSS must be an integer" >&2
    exit 64
    ;;
esac

if [ "$TS_FORWARD_MSS" -lt 536 ] || [ "$TS_FORWARD_MSS" -gt 65495 ]; then
  echo "TS_FORWARD_MSS must be between 536 and 65495" >&2
  exit 64
fi

minimum_unclamped_mss=$((TS_FORWARD_MSS + 1))

ensure_mss_rule() {
  direction="$1"

  if iptables --wait -t mangle -C FORWARD \
    "$direction" tailscale0 \
    -p tcp -m tcp --tcp-flags SYN,RST SYN \
    -m tcpmss --mss "${minimum_unclamped_mss}:65535" \
    -m comment --comment tailscale-forward-mss \
    -j TCPMSS --set-mss "$TS_FORWARD_MSS" 2>/dev/null; then
    return
  fi

  iptables --wait -t mangle -A FORWARD \
    "$direction" tailscale0 \
    -p tcp -m tcp --tcp-flags SYN,RST SYN \
    -m tcpmss --mss "${minimum_unclamped_mss}:65535" \
    -m comment --comment tailscale-forward-mss \
    -j TCPMSS --set-mss "$TS_FORWARD_MSS"
}

# Clamp both sides of forwarded TCP connections. Narrower advertised MSS values
# are preserved, and the rules remain local to this container's network namespace.
ensure_mss_rule -i
ensure_mss_rule -o

exec "$@"
