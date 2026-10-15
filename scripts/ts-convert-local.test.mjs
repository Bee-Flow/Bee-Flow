import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, extractCode, pool, requestBody, RULES } from './ts-convert-local.mjs';

test('the prompt carries the rules and the file as a code block', () => {
    const [system, user] = buildMessages('src/x/A.jsx', 'export default 1;\n');
    assert.equal(system.content, RULES);
    assert.match(user.content, /File: agent-hub\/src\/x\/A\.jsx/);
    assert.match(user.content, /```jsx\nexport default 1;\n\n```/);
});

test('the request is greedy, with thinking off unless asked', () => {
    const body = requestBody('m', [], {});
    assert.equal(body.temperature, 0); assert.equal(body.top_k, 1);
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
    assert.equal(requestBody('m', [], { thinking: true }).chat_template_kwargs.enable_thinking, true);
});

test('extractCode takes exactly one code block and rejects chatter or none', () => {
    assert.equal(extractCode('Here you go:\n```tsx\nexport const a: number = 1;\n```\nDone.'), 'export const a: number = 1;\n');
    assert.equal(extractCode('no block here'), null);
    assert.equal(extractCode('```tsx\nexport a\n```\n```tsx\nexport b\n```'), null);
    assert.equal(extractCode('```tsx\nconst a = 1;\n```'), null, 'a body without import/export is not a module');
});

test('pool runs at most n at a time and returns every result', async () => {
    let running = 0, peak = 0;
    const out = await pool([1, 2, 3, 4, 5], 2, async (x) => {
        running++; peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--; return x * 2;
    });
    assert.equal(peak, 2);
    assert.deepEqual(out.sort((a, b) => a - b), [2, 4, 6, 8, 10]);
});

test('the rules name the React failure mode and every escape hatch', () => {
    assert.match(RULES, /React\.ChangeEvent/);
    assert.match(RULES, /destructured props/);
    for (const word of ['any', 'as unknown as', '@ts-ignore', '@ts-expect-error', 'eslint-disable', 'non-null']) assert.match(RULES, new RegExp(word.replace(/[-@]/g, '\\$&')));
});
