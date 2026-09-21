"""AI model registry: persisted model ids, runtime tiers, display names and
worker compatibility.

Persisted identifiers (``qwen38``, prompt versions, result keys) never change
here; this module only maps them to tiers and user-facing names.
"""

from production.ai_types import PRODUCTION_AI_MODEL_IDS


LOCAL_AI_MODEL_ID = "qwen38"          # routine tier, on-device worker
DEEP_ANALYSIS_MODEL_ID = "chatgpt"     # daily ChatGPT desktop analysis
LEGACY_DEEP_ANALYSIS_MODEL_ID = "claude"
DEEP_ANALYSIS_MODEL_IDS = (DEEP_ANALYSIS_MODEL_ID, LEGACY_DEEP_ANALYSIS_MODEL_ID)

AI_MODEL_TIER_LOCAL = "local"
AI_MODEL_TIER_DEEP = "deep"

AI_MODEL_TIERS = {
    LOCAL_AI_MODEL_ID: AI_MODEL_TIER_LOCAL,
    DEEP_ANALYSIS_MODEL_ID: AI_MODEL_TIER_DEEP,
    LEGACY_DEEP_ANALYSIS_MODEL_ID: AI_MODEL_TIER_DEEP,
}
AI_MODEL_DISPLAY_NAMES = {
    LOCAL_AI_MODEL_ID: "Qwen 3.8 27B",
    DEEP_ANALYSIS_MODEL_ID: "ChatGPT",
    LEGACY_DEEP_ANALYSIS_MODEL_ID: "Claude",
}

# The daily quality summary and the photo audit stay on the local tier.
QUALITY_DAILY_MODEL_ID = LOCAL_AI_MODEL_ID

# Preferred worker version (returned in 409 bodies) and the set the backend
# accepts, so a rollout can keep an old and a new worker version claiming.
SUPPORTED_AI_WORKER_VERSION = "production-ai-worker-v2"
SUPPORTED_AI_WORKER_VERSIONS = (SUPPORTED_AI_WORKER_VERSION,)

AI_WORKER_CAPABILITY_MODEL_IDS = tuple(
    dict.fromkeys((
        *PRODUCTION_AI_MODEL_IDS,
        QUALITY_DAILY_MODEL_ID,
        DEEP_ANALYSIS_MODEL_ID,
    ))
)


def display_model_name(value):
    """Reduce a worker-reported checkpoint path to its basename."""
    return str(value or '').replace('\\', '/').rsplit('/', 1)[-1][:128]


def model_display_name(model_id, model_name=""):
    """Registry display name for a known model id, else the checkpoint basename."""
    key = str(model_id or "").strip()
    if key in AI_MODEL_DISPLAY_NAMES:
        return AI_MODEL_DISPLAY_NAMES[key]
    return display_model_name(model_name)


def model_tier(model_id):
    """Return ``local`` / ``deep`` for a registry id, else ``None``."""
    return AI_MODEL_TIERS.get(str(model_id or "").strip())


def worker_tier_for_model_ids(model_ids):
    """A worker advertising the deep model is the deep tier; everything else is local."""
    advertised = {str(value or "").strip() for value in (model_ids or [])}
    if advertised.intersection(DEEP_ANALYSIS_MODEL_IDS):
        return AI_MODEL_TIER_DEEP
    return AI_MODEL_TIER_LOCAL


def is_supported_worker_version(value):
    return str(value or "") in SUPPORTED_AI_WORKER_VERSIONS
