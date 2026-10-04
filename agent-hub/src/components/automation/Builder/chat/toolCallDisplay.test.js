import { describe, it, expect } from 'vitest';
import { addedStepsOf, describeLiveRun, describeToolCall, detailPayload } from './toolCallDisplay';
import { nodeTypeLabel } from '../flow/nodeDefs';

/** The shape the SSE stream really delivers: {name, arguments, result}. */
const call = (name, args, result) => ({ name, arguments: args, result });
const added = (type, label, extra = {}) => ({ added: { id: 's1', type, label, ...extra } });

describe('describeToolCall', () => {
    it('reads the step the builder actually created, not the tool name', () => {
        const d = describeToolCall(call('builder_add_http_request', { url: 'x' }, added('http_request', 'Fetch tickets')));
        expect(d.type).toBe('http_request');
        expect(d.detail).toBe('Fetch tickets');
        expect(d.title).not.toMatch(/builder_/);
        expect(d.status).toBe('done');
    });

    it('tells three identical builder_add_array_op calls apart', () => {
        // The whole point: the panel showed this name three times for three
        // different things, because it rendered the tool instead of the step.
        const rows = [
            added('filter', 'Keep high priority'),
            added('summarize', 'Count them'),
            added('aggregate', 'Collect the summaries'),
        ].map(r => describeToolCall(call('builder_add_array_op', {}, r)));
        const shown = rows.map(r => `${r.title} — ${r.detail}`);
        expect(new Set(shown).size).toBe(3);
        expect(shown.every(s => s.trim().length > 0)).toBe(true);
    });

    it('gives a past-tense verb to tools that create no step', () => {
        expect(describeToolCall(call('builder_finalize', {}, { ok: true })).title).toBe('Finished and saved');
        expect(describeToolCall(call('builder_propose_trigger', {}, { ok: true })).title).toBe('Set the trigger');
        expect(describeToolCall(call('builder_request_dry_run', {}, { run: {} })).title).toBe('Tested the automation');
    });

    it('uses the translator when one is supplied, and its key', () => {
        const t = (key, en) => (key === 'automations.builder.act.finalize' ? 'Afgerond en opgeslagen' : en);
        expect(describeToolCall(call('builder_finalize', {}, {}), t).title).toBe('Afgerond en opgeslagen');
    });

    it('marks a refusal as failed and keeps its reason and hint', () => {
        // Refusals must be shown, never hidden: a list of only the successful
        // calls reads as a complete story.
        const d = describeToolCall(call('builder_add_action', { tool: 'gmail_search' }, {
            error: '"gmail_search" is a Gmail action, and Gmail is not connected for this user.',
            _fixHint: 'Tell the user to connect Gmail first.',
        }));
        expect(d.status).toBe('failed');
        expect(d.error).toMatch(/not connected/);
        expect(d.hint).toMatch(/connect Gmail/);
    });

    it('degrades readably for a builder tool it has never heard of', () => {
        const d = describeToolCall(call('builder_add_teleporter', {}, { ok: true }));
        expect(d.title.length).toBeGreaterThan(0);
        expect(d.title).not.toMatch(/builder_/);
        expect(d.status).toBe('done');
    });

    it('survives a call with no name, no args and no result', () => {
        expect(() => describeToolCall({})).not.toThrow();
        expect(() => describeToolCall(null)).not.toThrow();
    });
});

/**
 * `builder_add_steps` reports its steps as an ARRAY of `{ id, type, tool? }`
 * (server/automation/builderTools/addSteps.js). The old `addedStep()` read
 * only a plain object, so a six-step batch was one grey "Steps" row with a
 * wrench, and the canvas had no idea in which order the model dealt them.
 */
describe('addedStepsOf', () => {
    it('one object → [obj]; an array → its plain objects; anything else → []', () => {
        const one = { id: 's1', type: 'ai_step' };
        expect(addedStepsOf({ added: one })).toEqual([one]);
        expect(addedStepsOf({ added: [one, null, 'x', { id: 's2', type: 'set' }] })).toEqual([one, { id: 's2', type: 'set' }]);
        expect(addedStepsOf({ ok: true })).toEqual([]);
        expect(addedStepsOf({ error: 'no' })).toEqual([]);
        expect(addedStepsOf(null)).toEqual([]);
        expect(addedStepsOf('plain')).toEqual([]);
        expect(addedStepsOf([{ id: 'not-a-result' }])).toEqual([]);
    });
});

describe('describeToolCall — a builder_add_steps batch', () => {
    const batch = (added) => call('builder_add_steps', { steps: [] }, { added, idMap: {} });
    const six = [
        { id: 'a', type: 'http_request' },
        { id: 'b', type: 'ai_step' },
        { id: 'c', type: 'integration_action', tool: 'gmail_send' },
        { id: 'd', type: 'set' },
        { id: 'e', type: 'condition' },
        { id: 'f', type: 'notification' },
    ];

    it('names the batch by its size and lists what each entry is, in the model\'s order', () => {
        const d = describeToolCall(batch(six));
        expect(d.title).toBe('Added 6 steps');
        expect(d.steps.map(s => s.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        expect(d.detail).toBe([
            nodeTypeLabel('http_request'), nodeTypeLabel('ai_step'), 'Gmail',
            nodeTypeLabel('set'), nodeTypeLabel('condition'), nodeTypeLabel('notification'),
        ].join(' · '));
        // No one type, no one family for a mixed batch: the tile stays neutral.
        expect(d.type).toBeNull();
        expect(d.family).toBeNull();
        expect(d.status).toBe('done');
    });

    it('an app entry is named by its app, and carries its tool and family for the canvas', () => {
        const d = describeToolCall(batch(six));
        expect(d.steps[2]).toEqual({ id: 'c', type: 'integration_action', tool: 'gmail_send', family: 'app', title: 'Gmail' });
        expect(d.steps[1]).toMatchObject({ id: 'b', type: 'ai_step', tool: null, family: 'ai' });
    });

    it('a batch of only apps keeps the app family; a batch of one reads "Added 1 step"', () => {
        const apps = describeToolCall(batch([
            { id: 'a', type: 'integration_action', tool: 'gmail_send' },
            { id: 'b', type: 'integration_action', tool: 'gmail_search' },
        ]));
        expect(apps.family).toBe('app');
        expect(apps.title).toBe('Added 2 steps');
        const one = describeToolCall(batch([{ id: 'a', type: 'ai_step' }]));
        expect(one.title).toBe('Added 1 step');
        expect(one.steps).toHaveLength(1);
        expect(one.type).toBeNull();
    });

    it('never invents a label for a batch entry', () => {
        const d = describeToolCall(batch([{ id: 'a', type: 'set' }, { id: 'b', type: 'set' }]));
        expect(d.detail).not.toContain('undefined');
        expect(d.detail).not.toContain('null');
        expect(d.steps.every(s => typeof s.title === 'string' && s.title.length > 0)).toBe(true);
    });

    it('uses the translator\'s keys, with the count interpolated', () => {
        const t = (key, en, params) => {
            if (key === 'automations.builder.act.add_steps') return `${params.n} stappen toegevoegd`;
            if (key === 'automations.builder.act.add_step_one') return '1 stap toegevoegd';
            return en;
        };
        expect(describeToolCall(batch(six), t).title).toBe('6 stappen toegevoegd');
        expect(describeToolCall(batch([six[0]]), t).title).toBe('1 stap toegevoegd');
    });

    it('a single-step tool keeps today\'s row and reports its one step in `steps`', () => {
        const d = describeToolCall(call('builder_add_http_request', {}, added('http_request', 'Fetch tickets')));
        expect(d.title).toBe(nodeTypeLabel('http_request'));
        expect(d.detail).toBe('Fetch tickets');
        expect(d.type).toBe('http_request');
        expect(d.steps).toEqual([{ id: 's1', type: 'http_request', tool: null, family: 'app', title: nodeTypeLabel('http_request') }]);
        // And a tool that created nothing reports none.
        expect(describeToolCall(call('builder_finalize', {}, { ok: true })).steps).toEqual([]);
    });

    it('a refused batch is failed, with its reason, and lists nothing', () => {
        const d = describeToolCall(call('builder_add_steps', {}, { error: 'steps[1]: unknown type "teleport".', failedIndex: 1 }));
        expect(d.status).toBe('failed');
        expect(d.steps).toEqual([]);
        expect(d.title.length).toBeGreaterThan(0);
    });
});

describe('detailPayload', () => {
    it('drops the whole-draft echo that rides on every mutation', () => {
        // builderTools appends _draftSteps/_stepIds to EVERY mutating result so
        // the model keeps the real ids. It repeats the entire step list and
        // says nothing about this call, so it would bury the two fields
        // somebody opened the details for.
        const p = detailPayload(call('builder_add_ai_step', { prompt: 'x' }, {
            added: { id: 's1', type: 'ai_step', label: 'Summarise' },
            _draftSteps: 'trigger > a > b > c',
            _stepIds: 'trg, s1',
        }));
        expect(p.result.added).toBeTruthy();
        expect(p.result._draftSteps).toBeUndefined();
        expect(p.result._stepIds).toBeUndefined();
        expect(p.args).toEqual({ prompt: 'x' });
    });

    it('passes a non-object result through untouched', () => {
        expect(detailPayload(call('x', {}, 'plain string')).result).toBe('plain string');
    });
});

describe('describeLiveRun', () => {
    it('names the step the run is on and how far it is', () => {
        const d = describeLiveRun({ label: 'Read file content', done: 1, total: 4 });
        expect(d.title).toBe('Testing the automation…');
        expect(d.detail).toBe('Read file content · 1/4');
        expect(d.status).toBe('running');
        expect(d.error).toBeNull();
        expect(d.steps).toEqual([]);
    });

    it('says only what the run has reported', () => {
        // Before the first row: no step, no count — never "0/0".
        expect(describeLiveRun(null).detail).toBe('');
        expect(describeLiveRun({ label: '', done: 0, total: 0 }).detail).toBe('');
        // A row but no label yet: the count alone.
        expect(describeLiveRun({ done: 2, total: 5 }).detail).toBe('2/5');
        // Never more done than total.
        expect(describeLiveRun({ done: 9, total: 5 }).detail).toBe('5/5');
    });

    it('translates through t', () => {
        const t = (k, d) => (k === 'automations.builder.act.dry_run_live' ? 'Automation wordt getest…' : d);
        expect(describeLiveRun({ label: 'x', done: 0, total: 1 }, t).title).toBe('Automation wordt getest…');
    });
});
