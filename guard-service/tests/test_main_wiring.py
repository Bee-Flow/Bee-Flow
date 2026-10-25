"""app/main.py cannot be imported without redis and the model stack, so its two
security properties are checked on the source: the key is required through the
shared fail-closed helper, and no CORS middleware is mounted.

    python -m unittest tests.test_main_wiring
"""

from __future__ import annotations

import ast
import pathlib
import unittest

MAIN = pathlib.Path(__file__).resolve().parent.parent / "app" / "main.py"


class MainWiring(unittest.TestCase):
    def setUp(self) -> None:
        self.tree = ast.parse(MAIN.read_text(encoding="utf-8"))
        self.names = {n.id for n in ast.walk(self.tree) if isinstance(n, ast.Name)}
        self.attrs = {
            n.attr for n in ast.walk(self.tree) if isinstance(n, ast.Attribute)
        }

    def test_no_cors_middleware(self) -> None:
        self.assertNotIn("CORSMiddleware", self.names | self.attrs)
        imported = {
            alias.name
            for n in ast.walk(self.tree)
            if isinstance(n, ast.ImportFrom)
            for alias in n.names
        }
        self.assertNotIn("CORSMiddleware", imported)

    def test_the_key_goes_through_require_api_key(self) -> None:
        calls = [
            n
            for n in ast.walk(self.tree)
            if isinstance(n, ast.Call)
            and getattr(n.func, "id", "") == "require_api_key"
        ]
        self.assertEqual(len(calls), 1)
        kwargs = {k.arg for k in calls[0].keywords}
        self.assertIn("allow_open_vars", kwargs)

    def test_imports_are_all_at_the_top(self) -> None:
        first_non_import = None
        for node in self.tree.body:
            is_import = isinstance(node, (ast.Import, ast.ImportFrom))
            if not is_import and first_non_import is None:
                if not (
                    isinstance(node, ast.Expr)
                    or isinstance(node, ast.Assign)
                    and node.targets[0].id == "_THREAD_CORES"
                ):
                    first_non_import = node
            elif is_import and first_non_import is not None:
                self.fail(f"import after code at line {node.lineno}")


if __name__ == "__main__":
    unittest.main()
