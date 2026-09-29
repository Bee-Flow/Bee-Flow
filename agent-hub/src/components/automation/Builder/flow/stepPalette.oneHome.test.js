import { describe, it, expect } from 'vitest';
import { buildStepGroups } from './stepPalette';

/**
 * "One category per command" (design 1f). Every addable step lives in exactly
 * ONE content section of the Home tab — Flow control, People & waiting, Data &
 * lists, Integrations. The Frequent row is the deliberate exception: it is a
 * shortcut row, and the design labels it as one.
 *
 * Before the redesign `flow_control` held ten items with three different jobs
 * (deciding, pausing for a person, and stopping), and `data` held the web
 * service call. Two places to look for the same step is one place too many.
 */
const catalog = { apps: [], steps: [], flags: { code: true } };

const keyOf = (it) => `${it.payload?.kind}:${it.payload?.mode || ''}`;

describe('stepPalette — one home per command', () => {
    it('names the four sections of the design, in its order', () => {
        const flow = buildStepGroups({ catalog }).find(g => g.key === 'flow');
        expect(flow.sections.map(s => s.key)).toEqual(['flow_control', 'people', 'data', 'integrations']);
        expect(flow.sections.map(s => s.title)).toEqual(['Flow control', 'People & waiting', 'Data & lists', 'Integrations']);
    });

    it('no step appears in two content sections', () => {
        const flow = buildStepGroups({ catalog }).find(g => g.key === 'flow');
        const seen = new Map();
        for (const sec of flow.sections) {
            for (const it of sec.items) {
                const k = keyOf(it);
                expect(seen.has(k), `${k} is in both ${seen.get(k)} and ${sec.key}`).toBe(false);
                seen.set(k, sec.key);
            }
        }
    });

    it('puts every step that waits for a person or a clock together', () => {
        const flow = buildStepGroups({ catalog }).find(g => g.key === 'flow');
        const people = flow.sections.find(s => s.key === 'people').items.map(keyOf);
        expect(people).toEqual(['form_page:input', 'form_page:ending', 'approval:', 'wait:', 'notification:']);
    });

    it('keeps the deciders, the loop, the shield, the two endings and the note in Flow control', () => {
        const flow = buildStepGroups({ catalog }).find(g => g.key === 'flow');
        const ids = flow.sections.find(s => s.key === 'flow_control').items.map(i => i.id);
        // De twee manieren waarop een run eindigt staan naast elkaar: slecht
        // (stop_error) en goed (return_to_app, terug naar de app die hem
        // startte). De annotatie blijft als laatste — dat is geen stroomstap.
        expect(ids).toEqual(['route', 'loop', 'privacy_shield', 'stop_error', 'return_to_app', 'note']);
    });

    it('moves the web service call and Code out of Data into Integrations', () => {
        const flow = buildStepGroups({ catalog }).find(g => g.key === 'flow');
        const data = flow.sections.find(s => s.key === 'data').items.map(i => i.id);
        expect(data).not.toContain('http_request');
        expect(data).not.toContain('code');
        // The document step stays with the data steps, as the design draws it.
        expect(data).toContain('generate_document');
        const integrations = flow.sections.find(s => s.key === 'integrations').items.map(i => i.id);
        expect(integrations).toEqual(['http_request', 'code']);
    });

    it('drops the Integrations section to the web service call alone when Code is off', () => {
        const flow = buildStepGroups({ catalog: { apps: [], steps: [], flags: {} } }).find(g => g.key === 'flow');
        expect(flow.sections.find(s => s.key === 'integrations').items.map(i => i.id)).toEqual(['http_request']);
    });
});
