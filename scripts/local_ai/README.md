# Mac Studio WJ AI Worker

WJ Reporting uses one outbound `launchd` service after login:

- `com.wj.local-ai-worker`: waits for the Qwen3.8 `/v1/models` response, polls the Render backend, ensures hourly jobs exist, and submits results.

The Qwen3.8 MLX endpoint is managed separately at `127.0.0.1:8082`. These
scripts do not start, stop, or restart that protected runtime. The Worker
advertises `qwen38` only when `/v1/models` reports the exact configured
Qwen3.8 checkpoint.

Production explanations, production questions, daily quality summaries, and
quality report audits all use the single canonical model ID `qwen38`.

The Worker token is stored in macOS Keychain. It is never written to a plist, `.env`, frontend bundle, or repository file.

## First-time setup

1. Generate and store the token, then copy it to the clipboard:

   ```bash
   ./scripts/local_ai/configure-worker-token.sh
   ```

2. In the Render `shared-secrets` environment group, set `AI_WORKER_TOKEN` to the clipboard value and redeploy the backend.
3. Confirm that the separately managed Qwen3.8 endpoint is ready on port 8082.
4. Install and start the outbound Worker:

   ```bash
   ./scripts/local_ai/install-launch-agents.sh
   ```

## Operations

```bash
launchctl print gui/$(id -u)/com.wj.local-ai-worker
tail -f ~/Library/Logs/wj-local-ai/worker.out.log
tail -f ~/Library/Logs/wj-local-ai/worker.err.log
```

To remove the Worker and any legacy WJ model launch agents while preserving
the Keychain token:

```bash
./scripts/local_ai/install-launch-agents.sh --uninstall
```
