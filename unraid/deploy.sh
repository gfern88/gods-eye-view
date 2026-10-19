#!/bin/bash
# Pull the fork's main (github.com/gfern88/gods-eye-view: upstream plus local changes),
# sync the Compose Manager project files, rebuild and restart the gods-eye-view stack.
# Run on the Unraid host:
#   bash /mnt/user/git/gods-eye-view/unraid/deploy.sh
# The script is read from the clone, so a change to deploy.sh itself takes effect on
# the run after the one that pulls it.
# First run clones the repo and creates appdata (.env from .env.example, owned by the
# container user 1000) - put keys in /mnt/user/appdata/gods-eye-view/.env, then rerun.
set -euo pipefail
PROJECT=/boot/config/plugins/compose.manager/projects/gods-eye-view
SRC=/mnt/user/git/gods-eye-view
DATA=/mnt/user/appdata/gods-eye-view
IP=10.1.1.241

REPO=https://github.com/gfern88/gods-eye-view.git
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" remote set-url origin "$REPO"
  # Deploy exactly what the fork's main holds; .env, cache and logs live in $DATA.
  git -C "$SRC" fetch -q origin main
  git -C "$SRC" reset --hard -q FETCH_HEAD
  git -C "$SRC" clean -fdq
else
  git clone "$REPO" "$SRC"
fi

# Compose Manager project files come from the fork's unraid/ directory.
mkdir -p "$PROJECT"
cp "$SRC/unraid/compose.yml" "$SRC/unraid/gods-eye-view.png" "$PROJECT/"

mkdir -p "$DATA/cache" "$DATA/logs"
[ -f "$DATA/.env" ] || { cp "$SRC/.env.example" "$DATA/.env"; chmod 600 "$DATA/.env"; }
chown -R 1000:1000 "$DATA"

printf 'gods-eye-view' > "$PROJECT/name"
printf '1' > "$PROJECT/has_build"
[ -f "$PROJECT/autostart" ] || printf 'true' > "$PROJECT/autostart"
printf '%s' "$PROJECT/gods-eye-view.png" > "$PROJECT/icon_url"
printf 'https://god.gf88.dev' > "$PROJECT/webui_url"

# Same project name Compose Manager uses, so its Update/Stop buttons act on this stack.
docker compose -p gods-eye-view -f "$PROJECT/compose.yml" up -d --build
docker image prune -f --filter label=com.docker.compose.project=gods-eye-view >/dev/null || true

# No published ports; check it on the tunnel network from the host (Vite takes a moment).
for _ in $(seq 1 30); do
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Host: god.gf88.dev' "http://$IP:4173/" || true)
  [ "$code" = 200 ] && { echo "index 200 at $IP:4173"; exit 0; }
  sleep 2
done
echo "index not ready (last code $code); docker logs gods-eye-view" >&2
exit 1
