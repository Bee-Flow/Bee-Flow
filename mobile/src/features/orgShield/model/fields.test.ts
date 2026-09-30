import { buildPayload, deepEqual, dirtyStages, normaliseDoc, readTerm, toggleId, withToolCategories } from './fields';

const SERVER_DEFAULT = {
    enabled: false,
    collectionIds: [],
    scope: { userInput: true, agentOutput: true },
    action: 'delete',
    euModeEnabled: false,
    piiDetectionCategories: [],
    piiDetectionConfidenceThreshold: 0.7,
    piiDetectionAction: 'block',
    piiFailureMode: 'fail_closed',
    attachmentLargeInputPolicy: 'fail_open',
    webSearchGuardPiiCategories: [],
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
    monitorIntegrations: false,
    applyToAutomations: true,
    piiAllowTerms: [],
    piiAllowPublicOrgs: true,
};

describe('normaliseDoc', () => {
    it('reads the server default document with the secure defaults', () => {
        const f = normaliseDoc(SERVER_DEFAULT);
        expect(f).toMatchObject({
            enabled: false,
            applyToAutomations: true,
            dlpMode: 'ask',
            piiAllowPublicOrgs: true,
            piiAction: 'block',
            piiFailureMode: 'fail_closed',
            scanKnowledgeBases: true,
            piiConfidenceThreshold: 0.7,
        });
    });

    it('drops unknown category ids, keeps legacy { term } allow entries, and reads absent keys as the runtime does', () => {
        const f = normaliseDoc({
            piiDetectionCategories: ['Person', 'Bogus'],
            toolPiiPolicy: { external: { blockCategories: ['Email', 'Nope'] } },
            piiAllowTerms: [' Shell ', { term: 'PostNL' }, { term: '' }, 3],
            dlpMode: 'auto-redact',
            piiFailureMode: 'fail_open',
            privacy_scan_knowledge_bases: false,
            customSensitiveTerms: [{ id: 'a', label: 'X', pattern: 'x', createdBy: 'u1' }],
        });
        expect(f.piiCategories).toEqual(['Person']);
        expect(f.toolPiiPolicy).toEqual({ external: { blockCategories: ['Email'] }, internal: { blockCategories: [] } });
        expect(f.piiAllowTerms).toEqual(['Shell', 'PostNL']);
        expect(f.dlpMode).toBe('ask');
        expect(f.piiFailureMode).toBe('fail_open');
        expect(f.scanKnowledgeBases).toBe(false);
        expect(f.customSensitiveTerms[0]).toEqual({ id: 'a', label: 'X', pattern: 'x', type: 'regex', caseSensitive: false, createdBy: 'u1' });
    });
});

describe('readTerm', () => {
    it('invents an id for a row without one and reads anything else as defaults', () => {
        expect(readTerm(null, 2)).toEqual({ id: 'term-2', label: '', pattern: '', type: 'regex', caseSensitive: false });
        expect(readTerm({ id: 'x', type: 'literal', caseSensitive: true }, 0)).toMatchObject({ type: 'literal', caseSensitive: true });
    });
});

describe('buildPayload', () => {
    it('lays the fields over the loaded document, keeps unknown keys and strips the server-written ones', () => {
        const doc = {
            ...SERVER_DEFAULT,
            dlpScope: 'all',
            futureKey: 42,
            clamped_fields: ['webSearchGuardEnabled'],
            clamped_tier: 'community',
            stalenessWarnings: [],
            updatedAt: 'x',
            updatedBy: 'y',
            implicitDefault: true,
        };
        const f = { ...normaliseDoc(doc), enabled: true, piiAction: 'block', showRawPayload: true };
        const body = buildPayload(doc, f);
        expect(body.enabled).toBe(true);
        expect(body.dlpScope).toBe('all');
        expect(body.futureKey).toBe(42);
        // Save-gated: only sent while the action is tokenize.
        expect(body.showRawPayload).toBe(false);
        for (const key of ['clamped_fields', 'clamped_tier', 'stalenessWarnings', 'updatedAt', 'updatedBy', 'implicitDefault']) {
            expect(body).not.toHaveProperty(key);
        }
        expect(buildPayload(doc, { ...f, piiAction: 'tokenize' }).showRawPayload).toBe(true);
        expect(Object.keys(body)).toEqual(expect.arrayContaining([
            'webSearchGuardEnabled', 'piiDetectionCategories', 'piiDetectionConfidenceThreshold',
            'piiDetectionAction', 'privacy_scan_knowledge_bases', 'customSensitiveTerms', 'piiAllowTerms',
        ]));
    });
});

describe('dirtyStages', () => {
    it('names each tab with edits, in pipeline order, and ignores keys no control owns', () => {
        const doc = { ...SERVER_DEFAULT, dlpScope: 'external' };
        const snap = buildPayload(doc, normaliseDoc(doc));
        const now = buildPayload({ ...doc, dlpScope: 'all' }, {
            ...normaliseDoc(doc),
            enabled: true,
            dlpEnabled: true,
            dlpMode: 'block',
            piiCategories: ['Person'],
        });
        expect(dirtyStages(now, snap)).toEqual([
            { id: 'overview', count: 1 },
            { id: 'detection', count: 1 },
            { id: 'outbound', count: 2 },
        ]);
        expect(dirtyStages(null, snap)).toEqual([]);
    });
});

describe('helpers', () => {
    it('deepEqual compares structure and array order', () => {
        expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
        expect(deepEqual([1, 2], [2, 1])).toBe(false);
        expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
        expect(deepEqual({ a: 1 }, [1])).toBe(false);
        expect(deepEqual(null, {})).toBe(false);
    });

    it('toggleId adds once and removes', () => {
        expect(toggleId(['a'], 'b', true)).toEqual(['a', 'b']);
        expect(toggleId(['a'], 'a', true)).toEqual(['a']);
        expect(toggleId(['a', 'b'], 'a', false)).toEqual(['b']);
    });

    it('withToolCategories replaces one class only', () => {
        const policy = { external: { blockCategories: ['Email'] }, internal: { blockCategories: [] } };
        expect(withToolCategories(policy, 'internal', ['Person'])).toEqual({
            external: { blockCategories: ['Email'] },
            internal: { blockCategories: ['Person'] },
        });
    });
});
