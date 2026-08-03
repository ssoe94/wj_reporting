#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"
user_name="$(id -un)"
user_id="$(id -u)"
user_home_dir="$(id -P "$user_name" | /usr/bin/awk -F: '{print $(NF-1)}')"
launch_agents_dir="$user_home_dir/Library/LaunchAgents"
log_dir="$user_home_dir/Library/Logs/wj-local-ai"
keychain_service="${AI_WORKER_KEYCHAIN_SERVICE:-com.wj.local-ai-worker.token}"

mlx_label="com.wj.local-ai-mlx"
worker_label="com.wj.local-ai-worker"
mlx_target="$launch_agents_dir/$mlx_label.plist"
worker_target="$launch_agents_dir/$worker_label.plist"

if [[ "${1:-}" == "--uninstall" ]]; then
  /bin/launchctl bootout "gui/$user_id" "$worker_target" 2>/dev/null || true
  /bin/launchctl bootout "gui/$user_id" "$mlx_target" 2>/dev/null || true
  /bin/rm -f "$worker_target" "$mlx_target"
  echo "Removed the WJ local AI launch agents. The Keychain token was preserved."
  exit 0
fi

if ! /usr/bin/security find-generic-password -a "$user_name" -s "$keychain_service" >/dev/null 2>&1; then
  echo "AI Worker token is not configured in macOS Keychain." >&2
  echo "Run: $script_dir/configure-worker-token.sh" >&2
  exit 78
fi

/bin/mkdir -p "$launch_agents_dir" "$log_dir"

render_plist() {
  local template_path="$1"
  local target_path="$2"
  local temporary_path="$target_path.tmp"
  /usr/bin/sed \
    -e "s|__REPO_DIR__|$repo_dir|g" \
    -e "s|__LOG_DIR__|$log_dir|g" \
    "$template_path" > "$temporary_path"
  /usr/bin/plutil -lint "$temporary_path" >/dev/null
  /bin/mv "$temporary_path" "$target_path"
}

render_plist "$script_dir/$mlx_label.plist.template" "$mlx_target"
render_plist "$script_dir/$worker_label.plist.template" "$worker_target"

/bin/launchctl bootout "gui/$user_id" "$worker_target" 2>/dev/null || true
/bin/launchctl bootout "gui/$user_id" "$mlx_target" 2>/dev/null || true
/bin/launchctl bootstrap "gui/$user_id" "$mlx_target"
/bin/launchctl bootstrap "gui/$user_id" "$worker_target"
/bin/launchctl enable "gui/$user_id/$mlx_label"
/bin/launchctl enable "gui/$user_id/$worker_label"
/bin/launchctl kickstart -k "gui/$user_id/$mlx_label"
/bin/launchctl kickstart -k "gui/$user_id/$worker_label"

echo "Installed and started $mlx_label and $worker_label."
echo "Logs: $log_dir"
