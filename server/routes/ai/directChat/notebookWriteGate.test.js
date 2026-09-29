/**
 * Notebook-write gate (BFSF-169).
 *
 * The gate used to be implemented by removing notebook_write/replace/insert
 * from the turn's tool list. That churned the prompt-cache prefix (tools are
 * serialised before the system prompt), so the decision moved to dispatch
 * time. These tests pin the DECISION, which is the part that carries the
 * safety property — an unrequested notebook write must still be impossible.
 *
 * Run: node --test routes/ai/directChat/notebookWriteGate.test.js
 */

const assert = require('assert');
const test = require('node:test');

const { evaluateNotebookWriteGate, isNotebookWriteTool } = require('./notebookWriteGate');

const gate = (over = {}) => evaluateNotebookWriteGate({
    message: '',
    hasAttachment: false,
    notebookPanelOpen: false,
    ...over,
});

test('write tools are recognised; read is not gated', () => {
    for (const n of ['notebook_write', 'notebook_replace', 'notebook_insert']) {
        assert.ok(isNotebookWriteTool(n), `${n} must be gated`);
    }
    assert.ok(!isNotebookWriteTool('notebook_read'), 'reads stay ungated');
    assert.ok(!isNotebookWriteTool('agent_search'));
});

test('denies a spontaneous write: no intent, panel closed', () => {
    const r = gate({ message: 'Summarise the French Revolution' });
    assert.strictEqual(r.allowed, false);
    assert.match(r.reason, /explicitly/i, 'the model is told what would unlock it');
});

test('allows when the user names the notebook (EN and NL)', () => {
    assert.strictEqual(gate({ message: 'save this to the notebook' }).allowed, true);
    assert.strictEqual(gate({ message: 'zet dit in mijn notitie' }).allowed, true);
    assert.strictEqual(gate({ message: 'noteer dit even' }).allowed, true);
});

test('allows on write intent alone', () => {
    assert.strictEqual(gate({ message: 'draft a memo about Q3' }).allowed, true);
});

test('allows whenever the panel is already open — the user is working in it', () => {
    assert.strictEqual(gate({ message: 'make it shorter', notebookPanelOpen: true }).allowed, true);
});

test('denies the attachment-Q&A shape even with the panel open', () => {
    // Short content question about a file. Privacy Shield tokenisation makes
    // these answers look long, which used to steer the model into a tool-only
    // notebook_write that surfaced as "Error generating response".
    const r = gate({ message: 'what is in the file?', hasAttachment: true, notebookPanelOpen: true });
    assert.strictEqual(r.allowed, false);
    assert.match(r.reason, /attached file/i);
});

test('an attachment turn with explicit write intent is allowed through', () => {
    assert.strictEqual(
        gate({ message: 'write a report about this file into the notebook', hasAttachment: true }).allowed,
        true,
    );
});

test('a long attachment question is not treated as the Q&A shape', () => {
    const long = 'Could you walk me through what this contract says about termination, '
        + 'notice periods, and the liability cap, in detail?';
    assert.ok(long.length >= 80);
    // Falls through to the standard gate: still denied (no intent, panel closed),
    // but for the write-intent reason rather than the attachment reason.
    const r = gate({ message: long, hasAttachment: true });
    assert.strictEqual(r.allowed, false);
    assert.match(r.reason, /has not asked/i);
});

test('non-string messages do not throw', () => {
    assert.strictEqual(gate({ message: undefined }).allowed, false);
    assert.strictEqual(gate({ message: null, notebookPanelOpen: true }).allowed, true);
});
