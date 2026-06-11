#!/usr/bin/env bash
# Wire raw.joel.net into the existing cloudflared tunnel on micro.
# Replaces /etc/cloudflared/config.yml whole (atomic, idempotent) and
# restarts cloudflared — expect a 1-3s blip on all tunneled hostnames.
# DNS route must already exist:
#   cloudflared tunnel route dns f3c71774-6810-4861-ba38-72c482818108 raw.joel.net
set -euo pipefail

sudo tee /etc/cloudflared/config.yml > /dev/null <<'EOF'
tunnel: f3c71774-6810-4861-ba38-72c482818108
credentials-file: /etc/cloudflared/f3c71774-6810-4861-ba38-72c482818108.json

ingress:
  - hostname: corsair.joel.net
    service: http://localhost:3100
  - hostname: owntracks.joel.net
    service: http://localhost:3000
  - hostname: raw.joel.net
    service: http://localhost:3102
  - service: http_status:404
EOF

sudo systemctl restart cloudflared

echo "Waiting for tunnel connections to re-establish..."
sleep 5

for host in corsair.joel.net owntracks.joel.net raw.joel.net; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://${host}/")
  echo "${host}: HTTP ${code}"
done
