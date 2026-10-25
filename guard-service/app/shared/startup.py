"""Fail-closed start-up check for the service API key.

A sidecar without a key would answer anyone who can reach its port, and it
processes personal data. So a missing key is a start-up error, unless the
operator says out loud that the service may run open (``SERVICES_ALLOW_OPEN=1``,
or a service-specific variable such as ``GUARD_ALLOW_OPEN=1``): a developer
stack bound to 127.0.0.1, for instance. ``./selfhost.sh`` generates the key.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping

logger = logging.getLogger(__name__)

# Only the exact value "1" opens the service: "true", "yes" or "0" do not.
OPEN_VALUE = "1"


class ApiKeyRequired(RuntimeError):
    """No API key is configured and the service was not told it may run open."""


def allowed_open(
    allow_open_vars: tuple[str, ...], env: Mapping[str, str] | None = None
) -> bool:
    env = os.environ if env is None else env
    return any(env.get(name, "").strip() == OPEN_VALUE for name in allow_open_vars)


def require_api_key(
    key: str,
    *,
    service: str,
    key_vars: str,
    allow_open_vars: tuple[str, ...] = ("SERVICES_ALLOW_OPEN",),
    env: Mapping[str, str] | None = None,
) -> str:
    """Return the key to enforce ("" only when the service may run open).

    Raises ApiKeyRequired, after one clear log line, when ``key`` is empty and
    none of ``allow_open_vars`` is set to ``1``.
    """
    if key:
        return key
    if allowed_open(allow_open_vars, env):
        logger.warning(  # nosemgrep: python.lang.security.audit.logging.logger-credential-leak.python-logger-credential-disclosure -- logs the names of the opt-out variables, never a key
            "%s runs WITHOUT an API key (%s=1). Anyone who can reach the port can use it.",
            service,
            "/".join(allow_open_vars),
        )
        return ""
    message = (
        f"{service} refuses to start: no API key. Set {key_vars} "
        f"(openssl rand -hex 24), or {' / '.join(allow_open_vars)}=1 to run "
        "open on a trusted network."
    )
    logger.critical(message)
    raise ApiKeyRequired(message)
