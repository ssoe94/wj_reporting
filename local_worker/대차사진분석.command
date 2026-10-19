#!/bin/zsh
set -e
cd "${0:A:h:h}"
# Reuse the owner's existing worker configuration; never copy it into this tree.
lgent_env_file="${LGENT_WORKER_ENV_FILE:-${0:A:h}/.env}"
if [[ ! -f "$lgent_env_file" ]]; then
  lgent_git_common="$(git rev-parse --git-common-dir)"
  lgent_main_root="${lgent_git_common:A:h}"
  lgent_env_file="$lgent_main_root/local_worker/.env"
fi
lgent_python="${LGENT_WORKER_PYTHON:-/Users/macstudio_ted/Developer/wj_reporting/backend/.venv/bin/python}"
"$lgent_python" -m local_worker.trolley_worker --env-file "$lgent_env_file"
read -k 1 "?완료 / 完成. 아무 키나 누르면 닫습니다 / 按任意键关闭"
