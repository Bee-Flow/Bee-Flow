/**
 * Every path the builder SHIPS — in the curated templates, the few-shot
 * examples and the system prompts — is one the run reads, written in the
 * canonical spelling the builder itself stores.
 *
 * REGRESSION (audit:server-static-paths, 2026-10): the prompt, two few-shot
 * calls and two templates taught `trigger.output.attachments.0.attachmentId`,
 * which the runtime's old REF_RE never resolved (the attachment step got no
 * id, the upload no name), while the editor's lax preview showed the right
 * value. Nothing checked shipped text against the grammar. A model copies
 * what it is shown, so the canonical form is the only form shown.
 *
 * Run: cd server && node --test automation/builderPrompt/shippedPaths.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listTemplates, getTemplate } = require('../templates');
const { buildFewShotMessages } = require('./fewShotExamples');
const { buildFullSystemPrompt, buildLeanSystemPrompt } = require('../builderPrompt');
const { isValidPath, canonicalPath, scanTemplate } = require('../expr');

const REF_KEYS = new Set(['overRef', 'arrayRef', 'sourceRef']);

/** Every [where, path] a definition-shaped value carries: refs, list refs, {{…}} placeholders. */
function pathsIn(value, where, out = []) {
    if (typeof value === 'string') {
        for (const p of scanTemplate(value)) if (p.type === 'ref') out.push([where, p.inner]);
        return out;
    }
    if (Array.isArray(value)) { value.forEach((v, i) => pathsIn(v, `${where}[${i}]`, out)); return out; }
    if (!value || typeof value !== 'object') return out;
    if (value.kind === 'ref' && typeof value.path === 'string') { out.push([where, value.path]); return out; }
    for (const [k, v] of Object.entries(value)) {
        if (REF_KEYS.has(k) && typeof v === 'string') out.push([`${where}.${k}`, v]);
        else pathsIn(v, `${where}.${k}`, out);
    }
    return out;
}

function assertCanonical(found) {
    assert.ok(found.length > 0, 'something was scanned');
    for (const [where, p] of found) {
        // A tempId handle (`steps.$read`) is a name like any other.
        assert.ok(isValidPath(p), `${where}: "${p}" is not a path the run reads`);
        assert.equal(canonicalPath(p), p, `${where}: "${p}" is not written canonically (expected "${canonicalPath(p)}")`);
    }
}

test('every curated template binds paths the run reads, canonically spelled', () => {
    const found = [];
    for (const card of listTemplates()) pathsIn(getTemplate(card.id).definition, card.id, found);
    assertCanonical(found);
});

test('every few-shot call binds paths the run reads, canonically spelled', () => {
    const found = [];
    for (const m of buildFewShotMessages(99, { toolset: 'full' })) {
        for (const tc of m.tool_calls || []) pathsIn(JSON.parse(tc.function.arguments), `${tc.id}`, found);
    }
    assertCanonical(found);
});

test('neither system prompt teaches a dot-index (`.0`) path', () => {
    const catalog = { apps: [{ id: 'gmail', label: 'Gmail', available: true, actions: [{ name: 'drive_upload_file', description: 'Upload', inputSchema: null }] }] };
    for (const [name, text] of [
        ['full', buildFullSystemPrompt({ catalog, codeStepEnabled: true })],
        ['lean', buildLeanSystemPrompt({ catalog, codeStepEnabled: true })],
    ]) {
        const dotIndex = text.match(/\b(?:trigger|steps|loop)\.[\w$.[\]"*=<>-]*?\.[0-9]+\b/g) || [];
        assert.deepEqual(dotIndex, [], `${name} prompt teaches ${dotIndex.join(', ')}`);
        assert.match(text, /\[\*\]/, `${name} prompt teaches [*]`);
        assert.match(text, /\[name="Subject"\]/, `${name} prompt teaches the match segment`);
    }
});
