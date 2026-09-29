// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { FIELD_STAGE, dirtyStages } from './orgShieldDirty';

/**
 * Which panes hold unsaved edits. The behaviour worth protecting is the last
 * case: a field this screen does not edit must never light up a pane, because
 * the chip is a promise that there is something there to look at.
 */

const BASE = {
    enabled: true,
    piiDetectionCategories: ['Email'],
    piiDetectionConfidenceThreshold: 0.7,
    piiDetectionAction: 'block',
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
    customDataTypes: [],
    customDataTests: {},
    piiAllowTerms: [],
    piiAllowPublicOrgs: true,
    showRawPayload: false,
    privacy_scan_knowledge_bases: true,
    applyToAutomations: true,
    dlpEnabled: false,
    dlpMode: 'ask',
    dlpAlwaysReview: false,
    webSearchGuardEnabled: false,
    disableSearchOnUpload: false,
    monitorIntegrations: false,
    euModeEnabled: false,
};

const diff = (over) => dirtyStages({ ...BASE, ...over }, BASE);

describe('dirtyStages', () => {
    it('reports nothing when nothing changed', () => {
        expect(dirtyStages(BASE, BASE)).toEqual([]);
    });

    it('needs both sides before it will claim anything', () => {
        // Mid-load there is no snapshot yet, and "everything is dirty" would
        // be both wrong and alarming.
        expect(dirtyStages(BASE, null)).toEqual([]);
        expect(dirtyStages(null, BASE)).toEqual([]);
    });

    it('attributes each field to the pane whose control owns it', () => {
        expect(diff({ piiDetectionCategories: ['Email', 'Person'] })).toEqual([{ id: 'detection', count: 1 }]);
        expect(diff({ piiDetectionAction: 'tokenize' })).toEqual([{ id: 'processing', count: 1 }]);
        expect(diff({ dlpEnabled: true })).toEqual([{ id: 'outbound', count: 1 }]);
        expect(diff({ enabled: false })).toEqual([{ id: 'overview', count: 1 }]);
    });

    it('puts the tool lists on DETECTION, where the matrix now lives', () => {
        // They used to be on the outbound pane. Pointing an admin there now
        // would send them to a pane that no longer has the control.
        const stages = diff({
            toolPiiPolicy: { external: { blockCategories: ['Email'] }, internal: { blockCategories: [] } },
        });
        expect(stages).toEqual([{ id: 'detection', count: 1 }]);
        expect(FIELD_STAGE.toolPiiPolicy).toBe('detection');
    });

    it('counts the changed fields within a pane', () => {
        const stages = diff({ dlpEnabled: true, dlpMode: 'block', euModeEnabled: true });
        expect(stages).toEqual([{ id: 'outbound', count: 3 }]);
    });

    it('lists several panes in pipeline order, master switch first', () => {
        const stages = diff({
            euModeEnabled: true,
            piiDetectionCategories: [],
            enabled: false,
            piiDetectionAction: 'tokenize',
            customDataTypes: [{ id: 'cdt_0123456789', name: 'Codes' }],
        });
        expect(stages.map(s => s.id)).toEqual(['overview', 'detection', 'owndata', 'processing', 'outbound']);
    });

    it('puts the org\'s own types and their tests on Your own data', () => {
        expect(diff({ customDataTypes: [{ id: 'cdt_0123456789', name: 'Codes' }] })).toEqual([{ id: 'owndata', count: 1 }]);
        expect(diff({ customDataTests: { cdt_0123456789: { examples: ['X'], sentences: [] } } })).toEqual([{ id: 'owndata', count: 1 }]);
        // The server's mirror of the old terms belongs to the same pane.
        expect(FIELD_STAGE.customSensitiveTerms).toBe('owndata');
        // "Never hidden" is edited beside the org's own types.
        expect(diff({ piiAllowTerms: ['Microsoft'] })).toEqual([{ id: 'owndata', count: 1 }]);
        expect(diff({ piiAllowPublicOrgs: false })).toEqual([{ id: 'owndata', count: 1 }]);
    });

    it('sends a switch on one of the org\'s own types to Your own data, not to the matrix', () => {
        // The switches are the type's id in the SAME lists the matrix edits,
        // and the matrix has no row for it: pointing there would be a lie.
        expect(diff({ piiDetectionCategories: ['Email', 'cdt_0123456789'] })).toEqual([{ id: 'owndata', count: 1 }]);
        expect(diff({
            toolPiiPolicy: { external: { blockCategories: ['cdt_0123456789'] }, internal: { blockCategories: [] } },
        })).toEqual([{ id: 'owndata', count: 1 }]);
    });

    it('names both panes when one list change touches a built-in kind and an own type', () => {
        expect(diff({ piiDetectionCategories: ['Person', 'cdt_0123456789'] }))
            .toEqual([{ id: 'detection', count: 1 }, { id: 'owndata', count: 1 }]);
    });

    it('sees a deep change inside an object field', () => {
        expect(diff({
            toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: ['Person'] } },
        })).toEqual([{ id: 'detection', count: 1 }]);
    });

    it('ignores fields this screen carries but does not edit', () => {
        // `piiFailureMode`, `dlpScope`, `attachmentLargeInputPolicy` and a key
        // from a future release all ride through a save untouched. If one of
        // them differs, the difference did not come from a control the admin
        // can see, so naming a pane would be a lie.
        expect(diff({
            piiFailureMode: 'fail_open',
            dlpScope: 'all',
            attachmentLargeInputPolicy: 'fail_closed',
            somethingAddedLater: { deeply: ['nested'] },
        })).toEqual([]);
    });
});
