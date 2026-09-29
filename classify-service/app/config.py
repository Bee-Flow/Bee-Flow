"""Classify service configuration, read once from CLASSIFY_* environment variables."""

from __future__ import annotations

import os
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# The model this image bakes when no build arg says otherwise. Only a fallback
# at runtime: the identity /health reports comes from <model_dir>/BAKED.json,
# which the bake script writes next to the weights it downloaded, so it cannot
# disagree with what is loaded.
DEFAULT_MODEL = "knowledgator/gliclass-multilang-mini"
DEFAULT_REVISION = "0bd888b6c3ef9fca5f0a9d407bddfbbc7623486b"


class Settings(BaseSettings):
    app_name: str = "classify-service"
    # Image identity, baked from the git sha by CI (Dockerfile ARG
    # CLASSIFY_BUILD_ID). Part of the engine fingerprint: a release that only
    # changes how a text is prepared changes scores while the model stays put.
    build_id: str = "dev"

    model: str = DEFAULT_MODEL
    model_revision: str = DEFAULT_REVISION
    # Where the bake script put the snapshot. Never downloaded at runtime:
    # production pods have no egress, and the image sets HF_HUB_OFFLINE=1.
    model_dir: str = "/opt/model"
    # float32 on purpose. The checkpoint is stored as bfloat16 and transformers
    # 5 loads a checkpoint in its stored dtype by default; on a CPU without
    # bf16 matmul units that is slower. Scores differ slightly between the
    # two, so keep this in step with whatever the eval harness loaded.
    dtype: Literal["float32", "bfloat16"] = "float32"

    # Each text is cut to max_chars characters first (a cheap pre-cut), then
    # to max_tokens tokens OF TEXT: the first max_tokens - 128 and the last
    # 128, the way the eval measured it (eval/MODEL-DECISIONS.md, "Per-step
    # text cap"). The label prompt comes on top, inside max_length, the
    # model's whole sequence. Feeding more text than this made scores worse.
    max_chars: int = Field(4000, ge=1)
    max_tokens: int = Field(512, ge=256)
    max_length: int = Field(1024, ge=512)
    # joint: every label in one forward pass per text (how the eval measured
    # it). independent: one pass per label, so no label's score depends on
    # which other labels were asked about, at labels-times the cost.
    label_mode: Literal["joint", "independent"] = "joint"
    # Reported to the caller; the caller decides. The eval's dev best for
    # gliclass-multilang-mini (eval/MODEL-DECISIONS.md): on held-out it sent
    # no item without a correct topic down any output.
    default_threshold: float = Field(0.75, gt=0.0, lt=1.0)

    # Admission: this many requests run, this many more wait, the rest get 429.
    max_concurrency: int = Field(1, ge=1)
    max_queue: int = Field(8, ge=0)
    max_body_bytes: int = Field(256 * 1024, ge=1024)

    # Falls back to SERVICES_API_KEY; see effective_api_key().
    api_key: str = ""
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    model_config = SettingsConfigDict(
        env_prefix="CLASSIFY_",
        env_file=".env",
        extra="ignore",
        protected_namespaces=(),
    )


def effective_api_key(cfg: Settings) -> str:
    """CLASSIFY_API_KEY when set, else the stack-wide SERVICES_API_KEY, else ""."""
    return cfg.api_key or os.getenv("SERVICES_API_KEY", "")


settings = Settings()
