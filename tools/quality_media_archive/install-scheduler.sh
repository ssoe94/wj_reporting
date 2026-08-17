#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
user_name="$(id -un)"
user_id="$(id -u)"
user_home_dir="$(id -P "$user_name" | /usr/bin/awk -F: '{print $(NF-1)}')"
launch_agents_dir="$user_home_dir/Library/LaunchAgents"
log_dir="$user_home_dir/Library/Logs/wj-quality-media-archive"
install_root="$user_home_dir/Library/Application Support/WJ/quality-media-archive"
label="com.wj.quality-media-archive"
target="$launch_agents_dir/$label.plist"
template="$script_dir/$label.plist.template"
python_bin="/opt/homebrew/opt/python@3.12/libexec/bin/python3"
runtime_files=(
  "__init__.py"
  "scheduler.py"
  "quality_media_archive.py"
  "api_sync.py"
  "archive_core.py"
)

if [[ "${1:-}" == "--uninstall" ]]; then
  /bin/launchctl bootout "gui/$user_id" "$target" 2>/dev/null || true
  /bin/rm -f "$target"
  echo "Removed $label. The Keychain refresh credential and Ted_SSD archive were preserved."
  exit 0
fi

if [[ ! -x "$python_bin" ]]; then
  echo "Required Homebrew Python is unavailable: $python_bin" >&2
  exit 69
fi

release_id="$({
  for runtime_file in "${runtime_files[@]}"; do
    /usr/bin/shasum -a 256 "$script_dir/$runtime_file"
  done
} | /usr/bin/shasum -a 256 | /usr/bin/awk '{print substr($1, 1, 16)}')"
install_dir="$install_root/releases/$release_id"

"$python_bin" -m py_compile \
  "$script_dir/scheduler.py" \
  "$script_dir/quality_media_archive.py" \
  "$script_dir/api_sync.py" \
  "$script_dir/archive_core.py"

umask 077
/bin/mkdir -p "$launch_agents_dir" "$log_dir" "$install_dir"
/bin/chmod 700 "$install_root" "$install_root/releases" "$install_dir" "$log_dir"
for runtime_file in "${runtime_files[@]}"; do
  mode="600"
  if [[ "$runtime_file" == "scheduler.py" || "$runtime_file" == "quality_media_archive.py" ]]; then
    mode="700"
  fi
  /usr/bin/install -m "$mode" "$script_dir/$runtime_file" "$install_dir/$runtime_file"
done
current_link="$install_root/current"
temporary_link="$install_root/.current.$release_id"
/bin/rm -f "$temporary_link"
/bin/ln -s "releases/$release_id" "$temporary_link"
/bin/rm -f "$current_link"
/bin/mv -f "$temporary_link" "$current_link"

temporary_path="$target.tmp"
/usr/bin/sed \
  -e "s|__INSTALL_DIR__|$install_dir|g" \
  -e "s|__LOG_DIR__|$log_dir|g" \
  "$template" > "$temporary_path"
/usr/bin/plutil -lint "$temporary_path" >/dev/null
/bin/chmod 600 "$temporary_path"
/bin/mv "$temporary_path" "$target"

/bin/launchctl bootout "gui/$user_id" "$target" 2>/dev/null || true
/bin/launchctl bootstrap "gui/$user_id" "$target"
/bin/launchctl enable "gui/$user_id/$label"

echo "Installed $label for daily execution at 23:30 local time."
echo "Runtime: $install_dir"
echo "Logs: $log_dir"

if "$python_bin" "$install_dir/scheduler.py" status | /usr/bin/grep -q '"refresh_credential_present": true'; then
  echo "Keychain credential is configured."
else
  echo "One-time sign-in is still required (the password is not stored):" >&2
  echo "  $python_bin '$install_dir/scheduler.py' configure" >&2
fi
