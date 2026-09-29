"""Refuse outbound page fetches that would reach private or internal addresses.

Same rule set as server/utils/ssrfGuard.js: loopback, RFC 1918, CGNAT,
link-local (cloud metadata lives there), unique-local and multicast ranges,
plus the well-known metadata hostname. Checked per hop, so a public page that
redirects inward is refused at the redirect.
"""

from __future__ import annotations

import asyncio
import ipaddress
from collections.abc import Awaitable, Callable

_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_PRIVATE_HOSTNAMES = {"localhost", "metadata.google.internal"}

Resolver = Callable[[str], Awaitable[list[str]]]


class PrivateTargetError(Exception):
    def __init__(self, host: str) -> None:
        super().__init__(f"Refused: {host} resolves to a private/internal address")
        self.host = host


def is_private_ip(address: str) -> bool:
    """True for any address a fetch from this service must never reach."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return True
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if isinstance(ip, ipaddress.IPv4Address) and ip in _CGNAT:
        return True
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _looks_like_ip(name: str) -> bool:
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return False


async def _resolve(host: str) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, None)
    return [info[4][0] for info in infos]


async def assert_public_host(host: str | None, resolve: Resolver = _resolve) -> None:
    """Raise PrivateTargetError unless every address ``host`` resolves to is public."""
    if not host:
        raise PrivateTargetError(str(host))
    name = host.strip("[]").lower()
    if name in _PRIVATE_HOSTNAMES or (_looks_like_ip(name) and is_private_ip(name)):
        raise PrivateTargetError(host)
    try:
        addresses = await resolve(name)
    except OSError as exc:
        raise PrivateTargetError(host) from exc
    if not addresses or any(is_private_ip(a) for a in addresses):
        raise PrivateTargetError(host)
