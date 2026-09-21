"""Daily ChatGPT deep-analysis bridge, using the existing outbound worker queue.

All remote commands first read the deployed deep-analysis contract. An old or
incompatible backend is a hard stop before heartbeat, enqueue, or claim. This
CLI provides evidence bundles and validates results; it does not launch ChatGPT,
select a subscription feature, or implement the ChatGPT Deep Research product.

``validate <job.json> <answer.json>`` is fully local and needs no token/network.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .claude_bridge import (
    AnswerValidationError,
    BridgeConfig as LegacyBridgeConfig,
    BridgeError,
    ClaudeBridge,
    RESULT_SCHEMA_VERSION,
    read_worker_token,
    validate_answer as validate_shared_answer,
)
from .render_client import RenderClient

DEEP_ANALYSIS_MODEL_ID = "chatgpt"
DEEP_ANALYSIS_PROMPT_VERSION = "deep-analysis-chatgpt-v1"
RESULT_SOURCE = "chatgpt_desktop_review"
DEFAULT_WORKER_NAME = "mac-studio-chatgpt-desktop"
DEFAULT_BRIDGE_HOME = "~/.local/share/wj-chatgpt-bridge"
EXPECTED_SCHEDULE = {
    "cadence": "daily",
    "hour": 9,
    "timezone": "Asia/Shanghai",
    "context_days": 7,
    "date_basis": "previous_completed_business_day",
}


@dataclass(frozen=True)
class BridgeConfig(LegacyBridgeConfig):
    worker_name: str = DEFAULT_WORKER_NAME
    bridge_home: Path = Path(DEFAULT_BRIDGE_HOME).expanduser()

    @classmethod
    def from_env(cls, environ: dict[str, str] | None = None) -> "BridgeConfig":
        env = os.environ if environ is None else environ
        inherited = LegacyBridgeConfig.from_env(env)
        return cls(
            api_base_url=inherited.api_base_url,
            worker_name=str(env.get("CHATGPT_WORKER_NAME") or DEFAULT_WORKER_NAME),
            bridge_home=Path(env.get("CHATGPT_BRIDGE_HOME") or DEFAULT_BRIDGE_HOME).expanduser(),
            keychain_service=inherited.keychain_service,
            keychain_account=inherited.keychain_account,
        )


def validate_answer(answer: Any, input_payload: dict[str, Any]) -> dict[str, Any]:
    return validate_shared_answer(
        answer, input_payload, model_id=DEEP_ANALYSIS_MODEL_ID, source=RESULT_SOURCE,
    )


def _read_json(path: str | Path) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise AnswerValidationError("The local input file must contain readable JSON.") from exc
    if not isinstance(value, dict):
        raise AnswerValidationError("The local input file must contain a JSON object.")
    return value


def validate_local(job_path: str | Path, answer_path: str | Path) -> dict[str, Any]:
    """Validate a saved job/fixture and answer without credentials or API calls."""
    job = _read_json(job_path)
    ChatGPTBridge.check_job_identity(job)
    validate_answer(_read_json(answer_path), job.get("input_payload") or {})
    return {"ok": True, "local_validation_only": True, "model_id": DEEP_ANALYSIS_MODEL_ID}


class ChatGPTBridge(ClaudeBridge):
    model_id = DEEP_ANALYSIS_MODEL_ID
    result_source = RESULT_SOURCE
    prompt_version = DEEP_ANALYSIS_PROMPT_VERSION
    cli_module = "local_worker.chatgpt_bridge"

    def readiness(self) -> dict[str, Any]:
        """Read capability only. Never advertise readiness to an old deployment."""
        try:
            config = self.client.get_deep_analysis_config()
        except Exception as exc:
            raise BridgeError(
                "The deployed daily ChatGPT contract could not be verified. "
                "Deploy and verify the backend before enabling the scheduled runner; no work was sent."
            ) from exc
        expected = {
            "model_id": self.model_id,
            "cadence": "daily",
            "input_schema_version": "deep-analysis-input.v1",
            "result_schema_version": RESULT_SCHEMA_VERSION,
            "result_source": self.result_source,
        }
        if (
            not isinstance(config, dict)
            or any(config.get(key) != value for key, value in expected.items())
            or config.get("schedule") != EXPECTED_SCHEDULE
        ):
            raise BridgeError("The deployed backend does not support the daily ChatGPT contract; no work was sent.")
        return {"ok": True, "ready": True, **expected, "schedule": config["schedule"]}

    def heartbeat(self, last_error: str = "") -> dict[str, Any]:
        self.readiness()
        return super().heartbeat(last_error=last_error)

    def enqueue(self) -> dict[str, Any]:
        self.readiness()
        response = self.client.enqueue_periodic_jobs(languages=["ko", "zh"], job_types=["deep_analysis"])
        deep = response.get("deep_analysis") if isinstance(response, dict) else None
        if not isinstance(deep, dict) or deep.get("model_id") != self.model_id or deep.get("cadence") != "daily":
            raise BridgeError("The enqueue response did not confirm daily ChatGPT routing; do not claim jobs.")
        return response

    @staticmethod
    def check_job_identity(job: dict[str, Any]) -> None:
        scope = job.get("scope") if isinstance(job.get("scope"), dict) else {}
        payload = job.get("input_payload") if isinstance(job.get("input_payload"), dict) else {}
        if job.get("job_type") != "deep_analysis" or scope.get("model_id") != DEEP_ANALYSIS_MODEL_ID:
            raise BridgeError("Refusing a job that is not a ChatGPT deep-analysis job.")
        if payload.get("schema_version") != "deep-analysis-input.v1":
            raise BridgeError("Refusing an unsupported deep-analysis input schema.")

    def _validate_claimed_job(self, job: dict[str, Any]) -> None:
        self.check_job_identity(job)
        if not job.get("claimed_at"):
            raise BridgeError("The claimed job has no lease timestamp; it was not started.")

    def claim(self) -> dict[str, Any]:
        self.readiness()
        return super().claim()

    def _claimed_record(self, job_id: int) -> dict[str, Any]:
        record = self._load_job_record(job_id)
        self.check_job_identity(record)
        lease = record.get("lease") if isinstance(record.get("lease"), dict) else {}
        if record.get("status") != "running" or not lease.get("claim_timestamp"):
            raise BridgeError("This local job record has no active claim; do not reuse a completed or lost lease.")
        if lease.get("worker_name") != self.config.worker_name:
            raise BridgeError("This local claim belongs to a different worker.")
        return record

    def submit(self, job_id: int, answer_path: str | Path) -> dict[str, Any]:
        self._claimed_record(job_id)
        self.readiness()
        return super().submit(job_id, answer_path)

    def _submission_result(self, job_id: int, response: Any) -> dict[str, Any]:
        """A successful HTTP response can contain a completed, rejected explanation.

        Never retry or fail a job after this response: the server may already have
        completed it. Distinguish transport submission from an accepted explanation.
        """
        remote = response if isinstance(response, dict) else {}
        result = remote.get("result_payload")
        result = result if isinstance(result, dict) else {}
        server_status = remote.get("status")
        completed = server_status == "completed"
        fallback = result.get("llm_fallback")
        summary = result.get("summary")
        accepted = (
            completed
            and result.get("schema_version") == RESULT_SCHEMA_VERSION
            and result.get("source") == self.result_source
            and result.get("model_id") == self.model_id
            and fallback is False
            and isinstance(summary, str)
            and bool(summary.strip())
        )
        if accepted:
            local_status = "completed"
            detail = "The server accepted the grounded explanation."
        elif completed and fallback is True:
            local_status = "completed_fallback"
            detail = "The server completed the job with a fallback; the explanation needs review. Do not resubmit or fail this job."
        else:
            local_status = "submission_unverified"
            detail = "The server response did not confirm an accepted explanation. Inspect server status before any further action; do not resubmit or fail this job."
        self._mark(job_id, local_status, detail)
        return {
            "ok": accepted,
            "submitted": True,
            "accepted_explanation": accepted,
            "needs_review": not accepted,
            "retry_submission": False,
            "job_id": int(job_id),
            "server_status": server_status if isinstance(server_status, str) else None,
            "local_status": local_status,
            "llm_fallback": fallback if isinstance(fallback, bool) else None,
            "llm_fallback_code": str(result.get("llm_fallback_code") or "")[:64],
            "prompt_version": self.prompt_version,
            "model_name": self.model_id,
            "detail": detail,
        }

    def fail(self, job_id: int, reason: str) -> dict[str, Any]:
        self._claimed_record(job_id)
        self.readiness()
        return super().fail(job_id, str(reason or "").strip() or "Daily ChatGPT analysis was abandoned.")

    def status(self, token_available: bool | None = None) -> dict[str, Any]:
        return {
            **super().status(token_available=token_available),
            "schedule": EXPECTED_SCHEDULE,
            "local_status_only": True,
            "backend_readiness_verified": False,
        }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="chatgpt_bridge", description=__doc__.split("\n\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("readiness", help="verify the deployed backend contract without writing anything")
    commands.add_parser("heartbeat", help="advertise the ChatGPT deep tier after verifying backend readiness")
    commands.add_parser("enqueue", help="enqueue only daily deep-analysis jobs for Korean and Chinese")
    commands.add_parser("claim", help="claim one ChatGPT deep-analysis job and write its evidence bundle")
    submit = commands.add_parser("submit", help="validate and complete a locally claimed job")
    submit.add_argument("job_id", type=int)
    submit.add_argument("answer_path")
    fail = commands.add_parser("fail", help="fail a locally claimed job with a factual reason")
    fail.add_argument("job_id", type=int)
    fail.add_argument("reason")
    commands.add_parser("status", help="show local configuration and running jobs without token/network access")
    validate = commands.add_parser("validate", help="validate a local answer with a saved job; no token/network")
    validate.add_argument("job_path")
    validate.add_argument("answer_path")
    return parser


def main(argv: list[str] | None = None, bridge: ChatGPTBridge | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "validate":
            output = validate_local(args.job_path, args.answer_path)
        else:
            if bridge is None:
                config = BridgeConfig.from_env()
                token = "" if args.command == "status" else read_worker_token(config)
                bridge = ChatGPTBridge(RenderClient(config.api_base_url, token), config)
                del token
            if args.command == "submit":
                output = bridge.submit(args.job_id, args.answer_path)
            elif args.command == "fail":
                output = bridge.fail(args.job_id, args.reason)
            else:
                output = getattr(bridge, args.command)()
    except AnswerValidationError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    except BridgeError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 2
    except Exception as exc:
        # Exception text can contain a URL or request data. Never echo it.
        print(json.dumps({"ok": False, "error": f"Bridge request failed ({exc.__class__.__name__})."}))
        return 3
    print(json.dumps(output, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
