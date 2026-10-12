// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { describeStepResult } from './stepResultChip';

/**
 * The result chip's phrase for every shape a run row's output can take. The
 * translator is stubbed with the English fallbacks so the strings asserted
 * here are what the dictionary carries under automations.canvas.result.*.
 */
const t = (key, fallback, params) => {
    let out = fallback;
    for (const [k, v] of Object.entries(params || {})) out = out.replace(`{${k}}`, String(v));
    return `${key.split('.').pop()}|${out}`;
};

describe('describeStepResult', () => {
    it('says nothing while the step is still running, queued or waiting', () => {
        expect(describeStepResult({ stepId: 'a', status: 'running', output: [1] }, t)).toBeNull();
        expect(describeStepResult({ stepId: 'a', status: 'queued' }, t)).toBeNull();
        expect(describeStepResult({ stepId: 'a', status: 'awaiting_form' }, t)).toBeNull();
        expect(describeStepResult({ stepId: 'a', status: 'awaiting_approval' }, t)).toBeNull();
    });

    it('says nothing for no row, no status, or no translator', () => {
        expect(describeStepResult(null, t)).toBeNull();
        expect(describeStepResult({ stepId: 'a' }, t)).toBeNull();
        expect(describeStepResult({ stepId: 'a', status: 'success', output: [1] }, null)).toBeNull();
    });

    it('failed — for both status words the runner uses', () => {
        expect(describeStepResult({ status: 'error', output: { items: [1, 2] } }, t)).toBe('failed|failed');
        expect(describeStepResult({ status: 'failed' }, t)).toBe('failed|failed');
    });

    it('skipped', () => {
        expect(describeStepResult({ status: 'skipped', output: [1, 2, 3] }, t)).toBe('skipped|skipped');
    });

    it('an array counts its items', () => {
        expect(describeStepResult({ status: 'success', output: [1, 2, 3] }, t)).toBe('items|3 items');
        expect(describeStepResult({ status: 'completed', output: ['x'] }, t)).toBe('items|1 items');
    });

    it('an object holding a list names files and rows by their key, anything else as items', () => {
        expect(describeStepResult({ status: 'success', output: { files: [{}, {}] } }, t)).toBe('files|2 files');
        expect(describeStepResult({ status: 'success', output: { rows: new Array(12).fill({}) } }, t)).toBe('rows|12 rows');
        expect(describeStepResult({ status: 'success', output: { results: [1, 2, 3, 4] } }, t)).toBe('items|4 items');
        expect(describeStepResult({ status: 'success', output: { events: [1] } }, t)).toBe('items|1 items');
        expect(describeStepResult({ status: 'success', output: { entries: [1, 2] } }, t)).toBe('items|2 items');
        expect(describeStepResult({ status: 'success', output: { items: [1, 2, 3, 4, 5] } }, t)).toBe('items|5 items');
    });

    it('the first list key in priority order wins when several are present', () => {
        expect(describeStepResult({ status: 'success', output: { rows: [1], files: [1, 2, 3] } }, t)).toBe('files|3 files');
    });

    it('an object that reports appended / created / uploaded / sent is "done"', () => {
        expect(describeStepResult({ status: 'success', output: { appended: true, range: 'A1:C9' } }, t)).toBe('ok|done');
        expect(describeStepResult({ status: 'success', output: { created: { id: 'x' } } }, t)).toBe('ok|done');
        expect(describeStepResult({ status: 'success', output: { uploaded: 1 } }, t)).toBe('ok|done');
        expect(describeStepResult({ status: 'success', output: { sent: true } }, t)).toBe('ok|done');
        // Falsy flags are not a report of success — fall through to the shape.
        expect(describeStepResult({ status: 'success', output: { sent: false } }, t)).toBe('ok|done');
    });

    it('a string counts its characters, an empty one is nothing', () => {
        expect(describeStepResult({ status: 'success', output: 'hello world' }, t)).toBe('chars|11 characters');
        expect(describeStepResult({ status: 'success', output: '' }, t)).toBe('empty|nothing');
    });

    it('null, an empty object, an empty array and an empty list are nothing', () => {
        expect(describeStepResult({ status: 'success', output: null }, t)).toBe('empty|nothing');
        expect(describeStepResult({ status: 'success' }, t)).toBe('empty|nothing');
        expect(describeStepResult({ status: 'success', output: {} }, t)).toBe('empty|nothing');
        expect(describeStepResult({ status: 'success', output: [] }, t)).toBe('empty|nothing');
        expect(describeStepResult({ status: 'success', output: { files: [] } }, t)).toBe('empty|nothing');
    });

    it('a non-empty object of unknown shape, a number or a boolean is "done"', () => {
        expect(describeStepResult({ status: 'success', output: { text: 'summary', score: 3 } }, t)).toBe('ok|done');
        expect(describeStepResult({ status: 'success', output: 42 }, t)).toBe('ok|done');
        expect(describeStepResult({ status: 'success', output: true }, t)).toBe('ok|done');
    });

    it('a Condition that kept part of a list reads "3 of 4 kept" (C5)', () => {
        const out = { items: [{ id: 1 }, { id: 2 }, { id: 3 }], inputCount: 4, rejectedCount: 1, count: 3 };
        expect(describeStepResult({ status: 'success', output: out }, t)).toBe('kept|3 of 4 kept');
        expect(describeStepResult({ status: 'success', output: { items: [], inputCount: 4, rejectedCount: 4 } }, t)).toBe('kept|0 of 4 kept');
        // Without the filter's counts, items is just a list.
        expect(describeStepResult({ status: 'success', output: { items: [1, 2] } }, t)).toBe('items|2 items');
    });

    it('a server-truncated output is a placeholder, not a shape to count', () => {
        expect(describeStepResult({ status: 'success', output: { __truncated__: true, bytes: 1e6 } }, t)).toBe('ok|done');
    });

    it('a pinned row describes the frozen output like any settled row', () => {
        expect(describeStepResult({ status: 'pinned', output: [1, 2] }, t)).toBe('items|2 items');
    });

    it('never puts a value in the chip — counts and shapes only', () => {
        const chip = describeStepResult({ status: 'success', output: { files: [{ name: 'passport.pdf' }] } }, t);
        expect(chip).not.toContain('passport');
        const str = describeStepResult({ status: 'success', output: 'john@example.com' }, t);
        expect(str).not.toContain('@');
    });
});
