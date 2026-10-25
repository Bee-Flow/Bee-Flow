"""Run: python -m unittest discover -s python-shared/tests -t python-shared"""

import unittest

from beeflow_service.startup import ApiKeyRequired, allowed_open, require_api_key

KW = {"service": "guard-service", "key_vars": "SERVICES_API_KEY"}


class RequireApiKey(unittest.TestCase):
    def test_a_configured_key_is_returned(self):
        self.assertEqual(require_api_key("k", env={}, **KW), "k")

    def test_no_key_refuses_to_start_with_a_clear_message(self):
        with (
            self.assertRaises(ApiKeyRequired) as ctx,
            self.assertLogs("beeflow_service.startup", "CRITICAL"),
        ):
            require_api_key("", env={}, **KW)
        self.assertIn("SERVICES_API_KEY", str(ctx.exception))
        self.assertIn("SERVICES_ALLOW_OPEN=1", str(ctx.exception))

    def test_allow_open_runs_without_a_key_and_warns(self):
        with self.assertLogs("beeflow_service.startup", "WARNING"):
            self.assertEqual(
                require_api_key("", env={"SERVICES_ALLOW_OPEN": "1"}, **KW), ""
            )

    def test_only_the_exact_value_one_opens_the_service(self):
        for value in ("0", "true", "yes", "", "2"):
            with (
                self.subTest(value=value),
                self.assertRaises(ApiKeyRequired),
                self.assertLogs("beeflow_service.startup", "CRITICAL"),
            ):
                require_api_key("", env={"SERVICES_ALLOW_OPEN": value}, **KW)

    def test_a_service_specific_variable_opens_it_too(self):
        vars_ = ("GUARD_ALLOW_OPEN", "SERVICES_ALLOW_OPEN")
        self.assertTrue(allowed_open(vars_, {"GUARD_ALLOW_OPEN": "1"}))
        self.assertFalse(allowed_open(vars_, {"CLASSIFY_ALLOW_OPEN": "1"}))

    def test_a_key_wins_over_allow_open(self):
        self.assertEqual(
            require_api_key("k", env={"SERVICES_ALLOW_OPEN": "1"}, **KW), "k"
        )


if __name__ == "__main__":
    unittest.main()
