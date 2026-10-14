"""The pattern tier checks its IBAN, Luhn and IP spans with pii_validators.

generic.py used to carry a private copy of these checks, and the IPv4 copy
had drifted from the one model spans go through: it handed each octet to
int() unchecked, so "+1.2.3.4" passed. These tests pin the shared behaviour
and that the pattern tier really uses it, so a new copy cannot drift back in.
"""

from __future__ import annotations

import unittest

from app.services import pii_validators as pv
from app.services.pii_regex import generic


class SharedValidatorTests(unittest.TestCase):
    def test_generic_uses_the_shared_functions(self):
        self.assertIs(generic._is_valid_iban, pv.is_valid_iban)
        self.assertIs(generic._is_valid_luhn, pv.is_valid_luhn)
        self.assertIs(generic._is_valid_ipv4, pv.is_valid_ipv4)
        self.assertIs(generic._is_valid_ipv6, pv.is_valid_ipv6)

    def test_ipv4_rejects_a_signed_octet(self):
        self.assertFalse(pv.is_valid_ipv4("+1.2.3.4"))
        self.assertFalse(pv.is_valid_ipv4("1.2.-3.4"))

    def test_ipv4_accepts_surrounding_whitespace(self):
        self.assertTrue(pv.is_valid_ipv4(" 1.2.3.4"))
        self.assertTrue(pv.is_valid_ipv4("1.2.3.4 "))

    def test_ipv4_bounds(self):
        self.assertTrue(pv.is_valid_ipv4("192.0.2.1"))
        self.assertTrue(pv.is_valid_ipv4("0.0.0.0"))
        self.assertFalse(pv.is_valid_ipv4("256.0.0.1"))
        self.assertFalse(pv.is_valid_ipv4("1.2.3"))
        self.assertFalse(pv.is_valid_ipv4("a.b.c.d"))

    def test_iban_and_luhn(self):
        self.assertTrue(pv.is_valid_iban("NL91ABNA0417164300"))
        self.assertTrue(pv.is_valid_iban("NL91 ABNA 0417 1643 00"))
        self.assertFalse(pv.is_valid_iban("NL91ABNA0417164301"))
        self.assertTrue(pv.is_valid_luhn("4111111111111111"))
        self.assertFalse(pv.is_valid_luhn("4111111111111112"))

    def test_iban_anysep_still_builds_on_the_shared_check(self):
        self.assertTrue(generic._is_valid_iban_anysep("NL91-ABNA-0417-1643-00"))
        self.assertFalse(generic._is_valid_iban_anysep("NL908830705B27"))


if __name__ == "__main__":
    unittest.main()
