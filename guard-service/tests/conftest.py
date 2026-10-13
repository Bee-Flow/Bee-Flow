"""pytest only: make ``from fakes import …`` resolve as it does under unittest.

``python -m unittest discover -s tests`` (what CI runs) puts this folder on
sys.path itself; pytest imports the tests as the ``tests`` package and does
not, so the shared fakes module would be unreachable by its short name.
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
