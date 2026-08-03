# Mac Studio Local AI Services

The Mac Studio runs two user-level `launchd` services after login:

- `com.wj.local-ai-mlx`: keeps the local Qwen MLX server running on `127.0.0.1:8080` and prevents idle system sleep while it runs.
- `com.wj.local-ai-worker`: waits for `/v1/models`, polls the Render backend, ensures hourly jobs exist, and submits results.

The Worker token is stored in macOS Keychain. It is never written to a plist, `.env`, frontend bundle, or repository file.

## First-time setup

1. Generate and store the token, then copy it to the clipboard:

   ```bash
   ./scripts/local_ai/configure-worker-token.sh
   ```

2. In the Render `shared-secrets` environment group, set `AI_WORKER_TOKEN` to the clipboard value and redeploy the backend.
3. Install and start the services:

   ```bash
   ./scripts/local_ai/install-launch-agents.sh
   ```

## Operations

```bash
launchctl print gui/$(id -u)/com.wj.local-ai-mlx
launchctl print gui/$(id -u)/com.wj.local-ai-worker
tail -f ~/Library/Logs/wj-local-ai/worker.out.log
tail -f ~/Library/Logs/wj-local-ai/worker.err.log
```

To remove the services while preserving the Keychain token:

```bash
./scripts/local_ai/install-launch-agents.sh --uninstall
```
