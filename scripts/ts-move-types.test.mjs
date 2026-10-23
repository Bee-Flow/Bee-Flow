import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeInto, moveTypes } from './ts-move-types.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ts = null;
try { ts = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript'); } catch { /* not installed */ }

test('declarations move with their JSDoc and imports; a free comment and local-bound types stay', { skip: !ts && 'agent-hub typescript not installed' }, () => {
    const src = "import type { User } from './u';\nconst LIMIT = 3;\n\n/* a note about the code below */\n\n/** One card. */\ninterface CardProps {\n    user: User;\n}\n\ntype Max = typeof LIMIT;\n\nexport interface Row { id: string }\n\nexport function Card(p: CardProps) { return p; }\n";
    const r = moveTypes(ts, src, '/x/Card.tsx');
    assert.deepEqual(r.moved, ['CardProps', 'Row']);
    assert.equal(r.types, "import type { User } from './u';\n\n/** One card. */\nexport interface CardProps {\n    user: User;\n}\n\nexport interface Row { id: string }\n");
    assert.match(r.source, /\/\* a note about the code below \*\//);
    assert.match(r.source, /type Max = typeof LIMIT;/);
    assert.match(r.source, /import type \{ CardProps, Row \} from '\.\/Card\.types';\nexport type \{ Row \} from '\.\/Card\.types';/);
});

test('merging into an existing types file drops a self-import and keeps its own imports first', () => {
    const out = mergeInto("import type { A } from './a';\n\nexport interface P { x: A }\n", "import type { A } from './a';\nimport type { P } from './card.types';\nimport type { B } from './b';\n\nexport interface Q { p: P; b: B }\n", 'card.types');
    assert.equal(out, "import type { A } from './a';\nimport type { B } from './b';\n\nexport interface P { x: A }\n\nexport interface Q { p: P; b: B }\n");
});
