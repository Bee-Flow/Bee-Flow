/**
 * DIFFERENTIAL lockstep: validation issues by step and by editor section,
 * against the web's matchValidationToStep.js, sectionForIssue.js and the two
 * issue helpers in displayHelpers.js. The records are shaped like the
 * server's (`{code, severity, path, message}`), paths included.
 */

import * as issues from './issues';
import { clone, FIXTURES } from './testing/fixtures';
import type { FlowDefinition, Validation } from './types';

jest.mock('lucide-react', () => new Proxy({}, { get: (_t, name) => (name === '__esModule' ? false : String(name)) }), { virtual: true });

const FLOW = '../../../../../agent-hub/src/components/automation/Builder/flow';
/* eslint-disable @typescript-eslint/no-require-imports */
const webMatch = require(`${FLOW}/matchValidationToStep.js`);
const webSection = require(`${FLOW}/sectionForIssue.js`);
const webDisplay = require(`${FLOW}/displayHelpers.js`);
/* eslint-enable @typescript-eslint/no-require-imports */

const rec = (path: string, code = 'x.y') => ({ code, severity: 'error' as const, path, message: `Step ${path} is wrong` });

const VALIDATION: Validation = {
    errors: [
        rec('steps[cond_1].expr'), rec('steps[act_a].inputs.to'), rec('steps[act_a].tool'), rec('steps[act_a].label'),
        rec('steps[act_a]'), rec('trigger.kind'), rec('trigger.params.x'), rec('triggers[trg_hook].kind'),
        rec('steps[sw].cases[1].name'), rec('steps[sw].matchMode'), rec('steps[sw].weird'), rec('steps[ai_1].agentId'),
        rec('steps[loop_1].body.steps[b_cond].expr'), rec('layers.enrich.steps[l1].fields'), rec('edges[3]'),
        { code: 'no.path' },
    ],
    warnings: [rec('steps[act_b].inputs'), rec('steps[notif_1].forEach.overRef'), rec('steps[fp].waitSeconds'), rec('layers.enrich.steps[l2].fields')],
};

const DEFS: FlowDefinition[] = Object.values(FIXTURES);

describe('matchValidationToStep / buildIssuesByStep', () => {
    it.each(DEFS.map((d, i) => [i, d] as const))('fixture %i', (_i, def) => {
        const ids = [def.trigger?.id, ...(def.triggers || []).map((t) => t.id), ...def.steps.map((s) => s.id), '', 'nope'];
        for (const id of ids) expect(issues.matchValidationToStep(VALIDATION, id)).toEqual(webMatch.matchValidationToStep(VALIDATION, id));
        expect([...issues.buildIssuesByStep(VALIDATION, def)]).toEqual([...webMatch.buildIssuesByStep(VALIDATION, def)]);
    });

    it('reaches the children of expanded containers through a sidecar', () => {
        const sidecar: [string, issues.InlineScope][] = [
            ['lp', { kind: 'loop', callStepId: 'loop_1', childIds: ['lp/b_cond', 'lp/b_set'] }],
            ['cl', { kind: 'flowlet', layerKey: 'enrich', childIds: ['cl/l1', 'cl/l2', 'cl/l3'] }],
            ['zz', { kind: 'flowlet', layerKey: 'none', childIds: ['zz/a'] }],
        ];
        const def = clone(FIXTURES.loopy as FlowDefinition);
        expect([...issues.buildIssuesByStep(VALIDATION, def, sidecar)]).toEqual([...webMatch.buildIssuesByStep(VALIDATION, def, sidecar)]);
        expect([...issues.buildIssuesByStep(null, def, sidecar)]).toEqual([...webMatch.buildIssuesByStep(null, def, sidecar)]);
        expect([...issues.buildIssuesByStep(VALIDATION, null)]).toEqual([]);
        expect(issues.matchValidationToStep(null, 'x')).toEqual({ errors: [], warnings: [] });
    });
});

describe('sectionsWithErrors', () => {
    it('uses the web taxonomy', () => {
        expect(issues.TAXONOMY).toEqual(webSection.TAXONOMY);
    });

    const steps = DEFS.flatMap((d) => [...(d.trigger ? [d.trigger] : []), ...(d.triggers || []), ...d.steps]);
    it.each(steps.map((s) => [`${s.id}:${s.type}`, s] as const))('%s', (_label, step) => {
        const mine = issues.matchValidationToStep(VALIDATION, step.id);
        expect([...issues.sectionsWithErrors(step, mine)].sort()).toEqual([...webSection.sectionsWithErrors(step, mine)].sort());
    });

    it('opens nothing for nothing, and names one record\'s section', () => {
        expect(issues.sectionsWithErrors(null, VALIDATION).size).toBe(0);
        expect(issues.sectionsWithErrors({ id: 'a', type: 'set' }, null).size).toBe(0);
        expect(issues.sectionsWithErrors({ id: 'a', type: 'loop_item' }, { errors: [rec('steps[a].x')] }).size).toBe(0);
        expect(issues.sectionForIssue({ id: 'act_a', type: 'integration_action' }, rec('steps[act_a].inputs.to'))).toBe('inputs');
        expect(issues.sectionForIssue({ id: 'act_a', type: 'integration_action' }, rec('steps[act_a].label'))).toBeNull();
        expect(issues.sectionForIssue({ id: 'act_a', type: 'integration_action' }, rec('steps[act_a].zzz'))).toBe('basics');
        expect(issues.sectionForIssue({ id: 'act_a', type: 'integration_action' }, { path: 5 } as never)).toBeNull();
        expect(issues.sectionForIssue({ id: 't', type: 'trigger' }, rec('trigger.params'))).toBe('config');
    });
});

describe('issue text', () => {
    it.each(DEFS.map((d, i) => [i, d] as const))('fixture %i: owner and humanised message match', (_i, def) => {
        const labels = webDisplay.buildStepLabelMap(def);
        for (const r of [...(VALIDATION.errors || []), ...(VALIDATION.warnings || []), rec('steps[act_a_long].x')]) {
            expect(issues.resolveOwningStepId(r, def)).toBe(webDisplay.resolveOwningStepId(r, def));
            expect(issues.humanizeIssueText(r.message as string, labels)).toBe(webDisplay.humanizeIssueText(r.message, labels));
        }
    });

    it('leaves text alone without labels', () => {
        expect(issues.humanizeIssueText('Step x', new Map())).toBe('Step x');
        expect(issues.humanizeIssueText('', new Map([['a', 'A']]))).toBe('');
        expect(issues.humanizeIssueText('Step x', new Map([['', 'A']]))).toBe(webDisplay.humanizeIssueText('Step x', new Map([['', 'A']])));
        expect(issues.resolveOwningStepId({ path: 1 } as never, FIXTURES.branchy)).toBeNull();
    });
});
