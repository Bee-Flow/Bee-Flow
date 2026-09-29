"""Make ``app`` mean THIS service's package while its tests collect and run.

Every sidecar names its package ``app``, so one pytest run over several of
them would otherwise import the first service's code for all of them. The
modules of every service are parked in one process-wide stash and swapped
into sys.modules by root, so a lazy ``from app.x import`` inside a handler
still finds the same module objects its service was collected with.

Also stands in for tiktoken when it is not installed: the splitter imports
it at module level, and the tests replace its encoder anyway.
"""

import importlib.util
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_STASH = "_beeflow_service_app_modules"

_stash: dict[str, dict] = getattr(sys, _STASH, None) or {}
setattr(sys, _STASH, _stash)
_stash.setdefault(ROOT, {})


def _own_the_app_package() -> None:
    if ROOT in sys.path:
        sys.path.remove(ROOT)
    sys.path.insert(0, ROOT)
    for name in list(sys.modules):
        if name != "app" and not name.startswith("app."):
            continue
        origin = getattr(sys.modules[name], "__file__", None) or ""
        owner = next((r for r in _stash if origin.startswith(r + os.sep)), None)
        if owner is not None:
            _stash[owner][name] = sys.modules[name]
        if owner != ROOT:
            del sys.modules[name]
    sys.modules.update(_stash[ROOT])


def pytest_pycollect_makemodule(module_path, parent):
    _own_the_app_package()
    return None


def pytest_runtest_setup(item):
    _own_the_app_package()


if importlib.util.find_spec("tiktoken") is None:
    from fakes import CharEncoding

    stub = types.ModuleType("tiktoken")
    stub.get_encoding = lambda name: CharEncoding()
    sys.modules["tiktoken"] = stub
