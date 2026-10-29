"""The shapes the PII service passes around as plain dicts.

An entity or an envelope is a JSON object as the API carries it: string keys, JSON
values. Naming the shape once keeps every signature that takes or returns one short.
"""

from typing import Any

JsonDict = dict[str, Any]
Entities = list[JsonDict]
