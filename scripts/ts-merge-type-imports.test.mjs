import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTypeImports } from './ts-merge-type-imports.mjs';

test('type imports of one module become one line, in the place of the first', () => {
    const src = "import x from 'y';\nimport type { A } from './t';\nimport type { B, A } from './t';\nimport type { C } from './u';\nconst a = 1;\n";
    assert.equal(mergeTypeImports(src), "import x from 'y';\nimport type { A, B } from './t';\nimport type { C } from './u';\nconst a = 1;\n");
    assert.equal(mergeTypeImports("import type React from 'react';\n"), "import type React from 'react';\n");
});

test('types of a module also imported for values join that import as `type X`', () => {
    const src = "import { Shield, Lock } from 'lucide-react';\nimport type { LucideIcon } from 'lucide-react';\nconst a = 1;\n";
    assert.equal(mergeTypeImports(src), "import { Shield, Lock, type LucideIcon } from 'lucide-react';\nconst a = 1;\n");
});

test('a multi-line value import takes the types one per line', () => {
    const src = "import {\n    Shield,\n    Lock,\n} from 'lucide-react';\nimport type { LucideIcon } from 'lucide-react';\nconst a = 1;\n";
    assert.equal(mergeTypeImports(src), "import {\n    Shield,\n    Lock,\n    type LucideIcon,\n} from 'lucide-react';\nconst a = 1;\n");
});
