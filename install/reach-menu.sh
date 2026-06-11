#!/usr/bin/env bash
#
# sidedoor reach menu, consent first, private first.
#
# Drop this into a docker compose style installer. Source it and call:
#
#   sidedoor_reach_menu <port> [app_name]
#
# The default choice exposes NOTHING. Private options come first; the public
# option is clearly marked as exposing the app to the internet. Where a URL is
# determinable it is left in the SIDEDOOR_REACH_URL variable for the caller.

sidedoor_lan_ip() {
  if command -v ipconfig >/dev/null 2>&1 && ipconfig getifaddr en0 >/dev/null 2>&1; then
    ipconfig getifaddr en0
  elif command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
    hostname -I | awk '{print $1}'
  else
    echo ""
  fi
}

sidedoor_reach_menu() {
  local port="${1:-3000}"
  local app="${2:-your app}"
  SIDEDOOR_REACH_URL=""

  printf '\n  Who should be able to reach %s?\n' "$app"
  printf '    1) This computer only            (default, nothing is exposed)\n'
  printf '    2) Other devices on this network (LAN, http, stays on your network)\n'
  printf '    3) Tailscale                     (private https from anywhere, your own devices)\n'
  printf '    4) A public URL via Cloudflare   (exposes it to the public internet)\n'
  printf '  Choose 1 to 4 (default 1): '
  local choice
  read -r choice

  case "${choice:-1}" in
    2)
      local ip
      ip="$(sidedoor_lan_ip)"
      if [ -n "$ip" ]; then
        SIDEDOOR_REACH_URL="http://${ip}:${port}"
        printf '  On your network at: %s\n' "$SIDEDOOR_REACH_URL"
        printf '  (http only, phones can open it but cannot install it as an app.)\n'
      else
        printf '  Could not determine your LAN IP, check your network settings.\n'
      fi
      ;;
    3)
      printf '  Tailscale, private, only your own devices:\n'
      printf '    1. Install Tailscale on this machine and your phone (same account):\n'
      printf '       https://tailscale.com/download\n'
      printf '    2. sudo tailscale up\n'
      printf '    3. sudo tailscale serve %s\n' "$port"
      printf '    Tailscale prints a private https URL ending in .ts.net, use that.\n'
      ;;
    4)
      printf '  WARNING: this exposes %s to the public internet.\n' "$app"
      if command -v cloudflared >/dev/null 2>&1; then
        printf '    Run: cloudflared tunnel --url http://localhost:%s\n' "$port"
      else
        printf '    Install cloudflared first (brew / apt / winget), then run:\n'
        printf '    cloudflared tunnel --url http://localhost:%s\n' "$port"
      fi
      printf '    Copy the https://<name>.trycloudflare.com URL it prints.\n'
      ;;
    *)
      printf '  Keeping it private to this computer. Nothing is exposed.\n'
      ;;
  esac
}
