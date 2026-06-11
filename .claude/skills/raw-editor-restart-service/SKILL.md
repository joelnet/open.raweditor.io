---
name: raw-editor-restart-service
description: Build and/or restart the raw-editor systemd service on this host so changes go live at raw.joel.net. Use when the user asks to build, deploy, restart, bounce, reload, start, or stop the RAW editor — or says "ship it" / "make my changes live" after editing frontend or server code.
user_invocable: true
---

# Raw Editor Build & Restart

The RAW editor runs under systemd as `raw-editor.service` (port 3102, exposed as raw.joel.net via cloudflared). systemd owns boot startup and crash restart; this skill is for making local changes live.

## Decide what's needed

The service runs `node server/app.js` with `NODE_ENV=production` and serves the prebuilt SPA from `dist/` **per-request** (no startup caching). So:

- **Frontend changed** (`src/`, `index.html`, `public/`): run `npm run build`. A restart is NOT required — new files are served immediately. The PWA service worker (autoUpdate) refreshes client caches on next load.
- **Server changed** (`server/`): restart the service. No build needed.
- **Both changed**: build, then restart.
- **deploy/raw-editor.service changed**: tell the user the unit file must be reinstalled with sudo (copy to /etc/systemd/system + daemon-reload) — hand those commands to the user, don't run them.

## Workflow

Build (when frontend changed):

```bash
npm run build
```

Restart (when server changed):

```bash
sudo -n systemctl restart raw-editor.service
```

Then verify it is healthy:

```bash
systemctl status raw-editor.service --no-pager
curl -s http://localhost:3102/healthz
```

If status is not clearly healthy, read recent logs:

```bash
sudo -n journalctl -u raw-editor.service -n 80 --no-pager
```

## Expected Healthy State

Treat the restart as successful when all are true:

- `Active: active (running)` appears in status.
- The service is loaded from `/etc/systemd/system/raw-editor.service`.
- Logs show `Listening on http://0.0.0.0:3102`.
- `curl http://localhost:3102/healthz` returns `{"ok":true}`.

## Reporting

Summarize the outcome with:

- whether the build succeeded (and the dist size line from vite, if built);
- whether the restart command succeeded;
- the active state and main PID from `systemctl status`;
- any warning, failure, or missing-health signal.

If the restart command fails because `sudo -n` requires a password or permission is denied, say that the narrow sudoers rule from `deploy/raw-editor-sudoers` is missing from /etc/sudoers.d and do not retry interactively.

## What NOT to do

- Never `pkill`, `kill -9`, or otherwise touch the node process directly — let systemd own the lifecycle.
- Never run `npm start` or `node server/app.js` manually on this host — it will fight the systemd-managed instance for port 3102.
- Never edit `/etc/systemd/system/raw-editor.service` directly. Edit `deploy/raw-editor.service` in the repo and reinstall.
- Don't restart for frontend-only changes — `npm run build` alone is enough.
