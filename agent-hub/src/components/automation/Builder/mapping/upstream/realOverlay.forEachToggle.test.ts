// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { computeUpstreamGroups as computeUpstreamGroupsJs, overlayGroupWithReal as overlayGroupWithRealJs } from './index';
import { eachField, type Field } from './fieldTree';
import { autoMapStep as autoMapStepJs } from '../autoMapInputs';
import { buildRealOutputMap } from '../realOutputs';

/**
 * "Run once per item" switched on or off AFTER a step ran: the last run's
 * output then has the other shape (flat, or the forEach envelope), and the
 * next run will produce what the step is configured for now. The fields
 * downstream follow the configuration, not the stale run. Also when the
 * shapes agree but no iteration returned anything (an empty list, every item
 * failed): there is no evidence against the per-item fields, so they stay.
 */
type Group = { id: string; basePath: string; fields: Field[]; sample?: unknown; hasRealData?: boolean };
const computeUpstreamGroups = computeUpstreamGroupsJs as (...args: unknown[]) => Group[];
const overlayGroupWithReal = overlayGroupWithRealJs as (group: unknown, real: unknown, opts?: { pinned?: boolean }) => Group;
const autoMapStep = autoMapStepJs as (...args: unknown[]) => { step: { inputs?: Record<string, { path?: string }>; forEach?: unknown }; mappedKeys: string[] };

const CATALOG = {
    apps: [{
        actions: [
            { name: 'list_ids', outputSample: { ids: ['m1'] } },
            { name: 'get_mail', outputSample: { subject: '', from: '' } },
            { name: 'post', inputSchema: { type: 'object', properties: { subject: { type: 'string' } }, required: ['subject'] } },
        ],
    }],
    triggerOutputs: {},
};

function def(perItem: boolean) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'src', type: 'integration_action', tool: 'list_ids', inputs: {} },
            { id: 'get', type: 'integration_action', tool: 'get_mail', inputs: {}, ...(perItem ? { forEach: { overRef: 'steps.src.output.ids', itemVar: 'id' } } : {}) },
            { id: 'dst', type: 'integration_action', tool: 'post', inputs: {} },
        ],
        edges: [{ from: 'trg', to: 'src' }, { from: 'src', to: 'get' }, { from: 'get', to: 'dst' }],
    };
}
const FLAT = { subject: 'Hi', from: 'x@y' };
const ENVELOPE = { iterations: 1, succeeded: 1, failed: 0, results: [{ index: 0, item: 'm1', output: FLAT, status: 'success' }] };

function getGroup(perItem: boolean, run: unknown) {
    const d = def(perItem);
    const real = buildRealOutputMap(d, [{ stepId: 'get', output: run }]);
    const g = computeUpstreamGroups(d, 'dst', CATALOG, real).find(x => x.id === 'get') as Group;
    const paths: string[] = [];
    eachField(g.fields, f => paths.push(f.path));
    return { g, paths, d, real };
}

describe('a step whose last run has the other shape', () => {
    it('switched ON after a flat run: the per-item fields the next run produces are offered', () => {
        const { paths } = getGroup(true, FLAT);
        expect(paths).toContain('steps.get.output.results[*].output.subject');
        expect(paths).toContain('steps.get.output.results[*].output.from');
        expect(paths).not.toContain('steps.get.output.subject');
    });

    it('switched OFF after a per-item run: the flat fields are offered, and auto-map binds them without fanning out', () => {
        const { paths, d, real } = getGroup(false, ENVELOPE);
        expect(paths).toContain('steps.get.output.subject');
        expect(paths).toContain('steps.get.output.from');
        expect(paths.some(p => p.includes('results[*]'))).toBe(false);
        const dst = d.steps.find(s => s.id === 'dst');
        const { step } = autoMapStep(dst, d, CATALOG, { realOutputById: real });
        expect(step.inputs?.subject?.path).toBe('steps.get.output.subject');
        expect(step.forEach).toBeUndefined();
    });
});

describe('a per-item run that returned nothing to read', () => {
    it('over an empty list: the per-item fields stay, the counters are real', () => {
        const { g, paths } = getGroup(true, { iterations: 0, succeeded: 0, failed: 0, results: [] });
        expect(paths).toContain('steps.get.output.results[*].output.subject');
        expect(paths).toContain('steps.get.output.results[*].output.from');
        expect(g.fields.find(f => f.path === 'steps.get.output.iterations')?.sample).toBe(0);
    });

    it('when every item failed: the per-item fields stay, the counters are real', () => {
        const run = { iterations: 2, succeeded: 0, failed: 2, results: [{ index: 0, item: 'm1', status: 'failed', error: 'x' }, { index: 1, item: 'm2', status: 'failed', error: 'y' }] };
        const { g, paths } = getGroup(true, run);
        expect(paths).toContain('steps.get.output.results[*].output.subject');
        expect(g.fields.find(f => f.path === 'steps.get.output.failed')?.sample).toBe(2);
        expect(g.hasRealData).toBe(true);
    });

    it('once an iteration returned output, a field the run did not produce is still dropped (a guess is not data)', () => {
        const { paths } = getGroup(true, { ...ENVELOPE, results: [{ index: 0, item: 'm1', output: { subject: 'Hi' }, status: 'success' }] });
        expect(paths).toContain('steps.get.output.results[*].output.subject');
        expect(paths).not.toContain('steps.get.output.results[*].output.from');
    });
});

describe('a PIN with the other shape', () => {
    // The runner hands a pin downstream as it is (execution.js), whatever the
    // step is configured for now: its own shape is the truth.
    const designGroup = (perItem: boolean) => computeUpstreamGroups(def(perItem), 'dst', CATALOG).find(x => x.id === 'get') as Group;
    const pathsOf = (g: Group) => {
        const out: string[] = [];
        eachField(g.fields, f => out.push(f.path));
        return out;
    };

    it('a flat pin on a per-item step offers the flat fields', () => {
        const g = overlayGroupWithReal(designGroup(true), FLAT, { pinned: true });
        expect(pathsOf(g)).toEqual(['steps.get.output.subject', 'steps.get.output.from']);
        expect(g.sample).toBe(FLAT);
    });

    it('an envelope pin on a plain step offers the per-item fields', () => {
        const g = overlayGroupWithReal(designGroup(false), ENVELOPE, { pinned: true });
        expect(pathsOf(g)).toContain('steps.get.output.results[*].output.subject');
        expect(pathsOf(g)).not.toContain('steps.get.output.subject');
    });

    it('a run (not a pin) with the other shape leaves the design-time group as it is', () => {
        const g = designGroup(true);
        expect(overlayGroupWithReal(g, FLAT)).toBe(g);
    });
});

describe('a step pinned before "run once per item" was switched', () => {
    function pinnedGroup(perItem: boolean, pin: unknown) {
        const d = def(perItem);
        const get = d.steps.find(s => s.id === 'get') as Record<string, unknown>;
        get.pinnedOutput = pin;
        // The pin, not a run, is what the map holds (and what the run hands downstream).
        const real = buildRealOutputMap(d, [{ stepId: 'get', output: perItem ? ENVELOPE : FLAT }]);
        const g = computeUpstreamGroups(d, 'dst', CATALOG, real).find(x => x.id === 'get') as Group;
        const paths: string[] = [];
        eachField(g.fields, f => paths.push(f.path));
        return paths;
    }

    it('offers the fields of the pin it will hand downstream', () => {
        expect(pinnedGroup(true, FLAT)).toEqual(['steps.get.output.subject', 'steps.get.output.from']);
        const fromEnvelopePin = pinnedGroup(false, ENVELOPE);
        expect(fromEnvelopePin).toContain('steps.get.output.results[*].output.subject');
        expect(fromEnvelopePin).not.toContain('steps.get.output.subject');
    });
});
