import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, extractCode, RULES } from './ts-convert-local.mjs';

test('the prompt carries the rules and the file as a code block', () => {
    const [system, user] = buildMessages('src/x/A.jsx', 'export default 1;\n');
    assert.equal(system.content, RULES);
    assert.match(user.content, /File: agent-hub\/src\/x\/A\.jsx/);
    assert.match(user.content, /```jsx\nexport default 1;\n\n```/);
});

test('extractCode takes exactly one code block and rejects chatter or none', () => {
    assert.equal(extractCode('Here you go:\n```tsx\nexport const a: number = 1;\n```\nDone.'), 'export const a: number = 1;\n');
    assert.equal(extractCode('no block here'), null);
    assert.equal(extractCode('```tsx\nexport a\n```\n```tsx\nexport b\n```'), null);
    assert.equal(extractCode('```tsx\nconst a = 1;\n```'), null, 'a body without import/export is not a module');
});

test('the rules forbid every escape hatch the gate cannot see', () => {
    for (const word of ['any', 'as unknown as', '@ts-ignore', '@ts-expect-error', 'eslint-disable', 'non-null']) assert.match(RULES, new RegExp(word.replace(/[-@]/g, '\\$&')));
});
