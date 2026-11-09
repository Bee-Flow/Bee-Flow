"""The token chunker never leaves a token outside every chunk.

No model, no torch: FakeTokenizer supplies whitespace tokens with offsets.
"""

from __future__ import annotations

import unittest

from app.services.pii import _chunk_text_tokens
from fakes import FakeTokenizer


class ChunkCoverageTests(unittest.TestCase):
    def test_whitespace_heavy_window_leaves_no_token_uncovered(self):
        # The minimum advance is counted in tokens, the snap in characters. A
        # window that is mostly blank lines let the snap retreat over more than
        # half its tokens, and the next chunk then started PAST the cut: the
        # tokens in between were never shown to the model.
        head = "\t".join(f"woord{i:03d}" for i in range(100))
        tail = "\t".join(f"t{i:03d}" for i in range(400))
        text = head + "\n" * 9000 + tail
        chunks = _chunk_text_tokens(
            text, FakeTokenizer(), budget_tokens=330, overlap_tokens=49
        )
        covered = [False] * len(text)
        for off, ch in chunks:
            self.assertEqual(text[off : off + len(ch)], ch)
            for k in range(off, off + len(ch)):
                covered[k] = True
        lost = [k for k, c in enumerate(text) if not c.isspace() and not covered[k]]
        self.assertEqual(lost, [], f"{len(lost)} chars were in no chunk")


if __name__ == "__main__":
    unittest.main()
