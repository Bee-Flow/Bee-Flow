import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewrite, rewriteTails } from './ts-convert-references.mjs';

const pairs = [{ file: 'src/a/flow/nodes/NoteNode.jsx', target: 'src/a/flow/nodes/NoteNode.tsx' }, { file: 'src/x/data/actions.js', target: 'src/x/data/actions.ts' }];
const allOld = ['src/a/flow/nodes/NoteNode.jsx', 'src/x/data/actions.js', 'src/a/flow/layout.js', 'src/b/flow/layout.js'];

test('a tail is rewritten only when the whole string is a tail of exactly one file', () => {
    assert.equal(rewriteTails("read('flow/nodes/NoteNode.jsx')", pairs, allOld), "read('flow/nodes/NoteNode.tsx')");
    assert.equal(rewriteTails('req(`${FLOW}/nodes/NoteNode.jsx`)', pairs, allOld), 'req(`${FLOW}/nodes/NoteNode.tsx`)');
    // a longer path that only ENDS like a converted file is another file
    assert.equal(rewriteTails("read('routes/automation/actions.js')", pairs, allOld), "read('routes/automation/actions.js')");
    assert.equal(rewriteTails("read('flow/layout.js')", [{ file: 'src/a/flow/layout.js', target: 'src/a/flow/layout.ts' }], allOld), "read('flow/layout.js')");
});

test('full paths and sibling specifiers follow; an import loses its extension', () => {
    assert.equal(rewrite('see agent-hub/src/a/flow/nodes/NoteNode.jsx here', 'mobile/x.ts', pairs), 'see agent-hub/src/a/flow/nodes/NoteNode.tsx here');
    assert.equal(rewrite("import N from './NoteNode.jsx';", 'agent-hub/src/a/flow/nodes/Other.tsx', pairs), "import N from './NoteNode';");
    assert.equal(rewrite("fs.readFileSync(path.join(here, 'NoteNode.jsx'))", 'agent-hub/src/a/flow/nodes/NoteNode.test.jsx', pairs), "fs.readFileSync(path.join(here, 'NoteNode.tsx'))");
});

test('a brace list in a ci.yml glob follows the file', () => {
    const p = [{ file: 'src/a/runtime/uiBits.jsx', target: 'src/a/runtime/uiBits.tsx' }];
    assert.equal(rewrite("- 'agent-hub/src/a/runtime/{resolve.ts,uiBits.jsx}'", '.github/workflows/ci.yml', p), "- 'agent-hub/src/a/runtime/{resolve.ts,uiBits.tsx}'");
});
