/**
 * What the api layer reads goes straight into the editor's pure modules, with
 * no cast: the catalog is the bindings layer's `Catalog`, the step picker's
 * `PaletteCatalog` and the display helpers' catalog; a finding is a model
 * `ValidationIssue`; a set of findings is a model `Validation`. `tsc --noEmit`
 * checks the assignments below; the runtime lines make them execute.
 */

import { readCatalog } from './catalogReader';
import type { FlowCatalog } from './catalogTypes';
import type { FlowAutomation, FlowIssue, IssueSet } from './types';
import { computeUpstreamGroups } from '../bindings';
import type { Catalog } from '../bindings/types';
import { actionDisplayLabel, buildIssuesByStep, buildStepGroups } from '../model';
import type { PaletteCatalog } from '../model/palette/types';
import type { FlowDefinition, Validation, ValidationIssue } from '../model/types';

const as = {
    bindingsCatalog: (c: FlowCatalog): Catalog => c,
    paletteCatalog: (c: FlowCatalog): PaletteCatalog => c,
    issue: (i: FlowIssue): ValidationIssue => i,
    validation: (v: IssueSet): Validation => v,
    definition: (a: FlowAutomation): FlowDefinition => a.definition,
};

const catalog = readCatalog({
    apps: [{ id: 'gmail', label: 'Gmail', available: true, actions: [{ name: 'gmail_send', label: 'Send', integrationId: 'gmail' }] }],
    flags: { code: true },
});

describe('api shapes flow into the model without a cast', () => {
    it('feeds the catalog to the variable picker, the step picker and the labels', () => {
        const definition: FlowDefinition = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 's1', type: 'set' }], edges: [{ from: 'trg', to: 's1' }] };
        expect(computeUpstreamGroups(definition, 's1', as.bindingsCatalog(catalog), null).map((g) => g.id)).toContain('trg');
        expect(buildStepGroups({ catalog: as.paletteCatalog(catalog) }).length).toBeGreaterThan(0);
        expect(actionDisplayLabel('gmail_send', catalog)).toBe('Gmail: Send');
        expect(Object.keys(as)).toHaveLength(5);
    });

    it('feeds findings to the per-step issue map', () => {
        const issue: FlowIssue = { severity: 'error', message: 'Broken', path: 'steps[s1].x' };
        expect(as.issue(issue)).toBe(issue);
        const set: IssueSet = { errors: [issue], warnings: [] };
        const definition: FlowDefinition = { steps: [{ id: 's1', type: 'set' }], edges: [] };
        expect(buildIssuesByStep(as.validation(set), definition).get('s1')?.errors).toEqual([issue]);
    });
});
