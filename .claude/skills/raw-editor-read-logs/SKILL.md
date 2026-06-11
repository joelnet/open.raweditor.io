---
name: raw-editor-read-logs
description: Read and summarize raw-editor service logs from journald on this project host. Use when the user asks for logs, errors, startup output, crash history, recent service activity, systemd status details, or troubleshooting for raw-editor.service / raw.joel.net.
user_invocable: true
---

# Raw Editor Read Logs

## Workflow

Read bounded recent logs by default:

```bash
sudo -n journalctl -u raw-editor.service -n 120 --no-pager
```

For service state, pair logs with status:

```bash
systemctl status raw-editor.service --no-pager
```

Use a larger bounded read only when the user asks for more history:

```bash
sudo -n journalctl -u raw-editor.service -n 300 --no-pager
```

For a specific time window: the sudoers rule does not allow `--since`/`--until`, so take a large bounded read and filter the output locally (grep by timestamp prefix) instead.

## Live Tailing

Use live tailing only when the user explicitly asks to follow logs:

```bash
sudo -n journalctl -u raw-editor.service -f
```

Do not leave a follow session running at the end of the turn. Stop it after collecting enough lines to answer.

## What To Look For

Call out:

- service start/stop/restart timestamps;
- `Listening on http://0.0.0.0:3102` after each start;
- `uncaughtException` or `unhandledRejection`;
- repeated restart loops (systemd retries every 5s on failure);
- systemd failures, timeouts, or non-zero exits.

The service is a static file server (Hono serving `dist/`) — it logs very little in normal operation. Sparse logs are healthy; request-level noise is not expected.

If `sudo -n` fails with a password prompt or permission error, say that the narrow sudoers rule from `deploy/raw-editor-sudoers` is missing from /etc/sudoers.d and do not retry interactively.
