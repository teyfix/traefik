#!/bin/sh

set -eu

die() {
  echo "$*" >&2
  exit 1
}

lookup_ipv4() {
  hostname="$1"
  result="$(nslookup -type=A "$hostname" 2>/dev/null | awk '/^Address: / { print $2 }' | tail -n1)"

  [ -n "$result" ] || die "Could not resolve IPv4 address for: $hostname"
  printf '%s\n' "$result"
}

main() {
  : "${TAIL_DOMAIN:?TAIL_DOMAIN is required}"
  : "${DIRECT_DOMAIN:?DIRECT_DOMAIN is required}"
  : "${TRAEFIK_DNS_NAME:?TRAEFIK_DNS_NAME is required}"

  export TRAEFIK_IP
  TRAEFIK_IP="$(lookup_ipv4 "$TRAEFIK_DNS_NAME")"

  gomplate -f /usr/src/app/Corefile.gotpl -o /usr/src/app/Corefile
  exec coredns -conf /usr/src/app/Corefile
}

main "$@"
