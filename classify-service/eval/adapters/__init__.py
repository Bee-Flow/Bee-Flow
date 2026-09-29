"""One module per candidate, each exposing the same small surface:

    load(**opts) -> dict          load the pinned revision on CPU; returns provenance
    tokenizer() -> tokenizer      the model's own fast tokenizer (offsets, counts)
    scores(texts, labels) -> [{label: score}]   every label scored, per text

`scores` must return a score for every label it was given, for every text, so
that a threshold can be swept afterwards without calling the model again.
"""

# name on the command line -> (module, load() keyword arguments)
ADAPTERS = {
    "gliclass": ("adapters.gliclass_adapter", {"variant": "mini"}),
    "gliclass-edge": ("adapters.gliclass_adapter", {"variant": "edge"}),
    "gliner2": ("adapters.gliner2_adapter", {}),
    "nli": ("adapters.nli_adapter", {}),
}

# Which requirements-eval-<env>.txt each adapter runs in.
ENV_OF = {
    "gliclass": "gliclass",
    "gliclass-edge": "gliclass",
    "gliner2": "gliner2",
    "nli": "nli",
}
