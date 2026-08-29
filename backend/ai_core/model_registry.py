"""Model IDs the outbound AI worker may advertise as ready."""

from production.ai_types import PRODUCTION_AI_MODEL_IDS


QUALITY_DAILY_MODEL_ID = "qwen38"
SUPPORTED_AI_WORKER_VERSION = "production-ai-worker-v2"
AI_WORKER_CAPABILITY_MODEL_IDS = tuple(
    dict.fromkeys((*PRODUCTION_AI_MODEL_IDS, QUALITY_DAILY_MODEL_ID))
)
