"""Page fetches must never reach private or internal addresses, on any hop.
Run: pytest search-service/tests
"""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.ssrf_guard import (
    PrivateTargetError,
    assert_public_host,
    is_private_ip,
)  # noqa: E402


@pytest.mark.parametrize(
    "address",
    [
        "10.0.0.1",
        "172.16.5.5",
        "192.168.1.1",
        "127.0.0.1",
        "0.0.0.0",
        "169.254.169.254",
        "100.64.0.1",
        "::1",
        "fe80::1",
        "fd00::1",
        "::ffff:10.0.0.1",
        "not-an-ip",
    ],
)
def test_private_addresses(address):
    assert is_private_ip(address) is True


@pytest.mark.parametrize(
    "address", ["8.8.8.8", "93.184.216.34", "2001:4860:4860::8888"]
)
def test_public_addresses(address):
    assert is_private_ip(address) is False


def _resolver(mapping):
    async def resolve(host):
        if host not in mapping:
            raise OSError("no such host")
        return mapping[host]

    return resolve


def test_public_hostname_passes():
    asyncio.run(
        assert_public_host(
            "example.com", resolve=_resolver({"example.com": ["93.184.216.34"]})
        )
    )


def test_hostname_resolving_inward_is_refused():
    with pytest.raises(PrivateTargetError):
        asyncio.run(
            assert_public_host(
                "evil.example",
                resolve=_resolver({"evil.example": ["93.184.216.34", "10.0.0.5"]}),
            )
        )


def test_ip_literal_and_metadata_hostname_are_refused_without_resolving():
    async def never(host):
        raise AssertionError("must not resolve")

    for host in (
        "10.1.1.1",
        "[::1]",
        "localhost",
        "metadata.google.internal",
        "169.254.169.254",
    ):
        with pytest.raises(PrivateTargetError):
            asyncio.run(assert_public_host(host, resolve=never))


def test_unresolvable_host_is_refused():
    with pytest.raises(PrivateTargetError):
        asyncio.run(assert_public_host("nope.invalid", resolve=_resolver({})))
