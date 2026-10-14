"""Model-free stand-ins shared by the guard-service tests.

One copy of each fake, so a change to what the real GLiNER model, its
tokenizer or Redis looks like is made once. Imported as ``from fakes import …``
under both runners: ``python -m unittest discover -s tests`` puts this folder
on sys.path, and ``conftest.py`` does the same for pytest.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

from app.services.pii import get_pii_service


def whitespace_tokenize(text, return_offsets_mapping=False):
    """The fast-tokenizer subset the chunker reads, one token per ``\\S+`` run."""
    toks = list(re.finditer(r"\S+", text))
    out = {"input_ids": [1] * len(toks)}
    if return_offsets_mapping:
        out["offset_mapping"] = [(m.start(), m.end()) for m in toks]
    return out


class FakeTokenizer:
    """Whitespace tokenizer with HF-style offset mapping — for token chunking.

    Mimics the subset of the fast-tokenizer API the chunker uses:
    ``tok(text, add_special_tokens=False, return_offsets_mapping=True)`` ->
    ``{"input_ids": [...], "offset_mapping": [(start, end), ...]}``.
    """

    def __call__(self, text, add_special_tokens=False, return_offsets_mapping=False):
        return whitespace_tokenize(text, return_offsets_mapping)


class FakeGliner:
    """Stand-in for the GLiNER model.

    ``predict_entities`` finds each configured name in the chunk and returns a
    span dict shaped like the real model's output. It deliberately IGNORES the
    ``threshold`` argument so the detector's own per-category floor logic (the
    thing we're testing) is what filters results.
    """

    def __init__(self, names, score=0.9, label="person", prompts=None):
        self.names = names
        self.score = score
        self.label = label
        # Custom label sets: {prompt: [(name, score), ...]}. A Mapping label
        # set ({id: prompt}) is answered with the mapping's KEYS as labels,
        # exactly like gliner 0.2.29 (the prompt is what the model reads, the
        # key is what it returns).
        self.prompts = prompts or {}
        # Every inference call: (texts, labels), in call order.
        self.calls = []

    def _predict_mapping(self, text, mapping):
        out = []
        for key, prompt in mapping.items():
            for name, score in self.prompts.get(prompt, ()):
                idx = text.find(name)
                while idx != -1:
                    out.append(
                        {
                            "label": key,
                            "score": score,
                            "start": idx,
                            "end": idx + len(name),
                            "text": name,
                        }
                    )
                    idx = text.find(name, idx + 1)
        return out

    def predict_entities(self, text, labels, threshold=0.0):
        if isinstance(labels, Mapping):
            return self._predict_mapping(text, labels)
        if self.label not in labels:
            return []
        out = []
        for name in self.names:
            idx = text.find(name)
            while idx != -1:
                out.append(
                    {
                        "label": self.label,
                        "score": self.score,
                        "start": idx,
                        "end": idx + len(name),
                        "text": name,
                    }
                )
                idx = text.find(name, idx + 1)
        return out

    def inference(self, texts, labels, threshold=0.0, **kwargs):
        # The service batches chunks per label group; mirror that by running
        # the single-text logic over each chunk and returning a list-per-text.
        self.last_inference_kwargs = kwargs
        self.calls.append((list(texts), labels))
        return [self.predict_entities(t, labels, threshold) for t in texts]


class FakeRedis:
    """The two calls the PII cache makes, backed by a dict."""

    def __init__(self):
        self.store = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value


def mark_ready(svc, model):
    """Put ``svc`` in the loaded state, backed by ``model``; returns the model."""
    svc._model = model
    svc._ready = True
    svc._load_error = None
    svc._backend = "fake"
    return model


def install_fake(names, score=0.9):
    """Force the singleton into a ready state backed by a fake model."""
    svc = get_pii_service()
    mark_ready(svc, FakeGliner(names, score=score))
    return svc
