// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { computeUpstreamGroups } from './index';

/**
 * A step that runs once per INNER item (each attachment of each mail) keeps
 * the outer item it came from (`forEach.parents`): "Comes in" offers the mail
 * as `loop.<outer>.*` right before the current attachment.
 */
const CATALOG = {
    apps: [{ actions: [{ name: 'gmail_search', outputSample: { results: [{ id: 'm1', subject: 'Invoice', attachments: [{ attachmentId: 'a1', filename: 'f.pdf' }] }] } }] }],
    triggerOutputs: {},
};
const DEF = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'search', type: 'integration_action', tool: 'gmail_search' },
        {
            id: 'save', type: 'integration_action', tool: 'x',
            forEach: {
                overRef: 'steps.search.output.results[*].attachments', itemVar: 'attachment',
                parents: [{ itemVar: 'result', overRef: 'steps.search.output.results' }],
            },
        },
    ],
    edges: [{ from: 'trg', to: 'search' }, { from: 'search', to: 'save' }],
};

describe('the outer item of a per-inner-item step', () => {
    it('is offered just before the current item', () => {
        const groups = computeUpstreamGroups(DEF, 'save', CATALOG) as Array<{ basePath: string; label: string; fields: Array<{ path: string }> }>;
        const bases = groups.map(g => g.basePath);
        const outer = bases.indexOf('loop.result');
        expect(outer).toBeGreaterThan(-1);
        expect(bases[outer + 1]).toBe('loop.attachment');
        expect(groups[outer].fields.map(f => f.path)).toContain('loop.result.subject');
    });
});
