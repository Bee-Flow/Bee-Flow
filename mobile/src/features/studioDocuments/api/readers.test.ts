import { readCondition, readContract, readDocument, readDocumentList, readStarters, readValidation, readVersions } from './readers';

const ROW = {
    id: 'd1',
    userId: 'u1',
    name: 'Invoice 42',
    docType: 'invoice',
    description: '',
    kind: 'document',
    visibility: 'private',
    folderId: null,
    categories: ['sales', 7],
    versionId: 'v1',
    htmlSize: '1200',
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-02T10:00:00Z',
};

const CONTRACT = {
    schemaVersion: 1,
    instructions: 'Use supplied figures.',
    parameters: [
        { key: 'customer.name', type: 'text', label: 'Customer name', required: true, summary: 'Who', instructions: 'Verified.' },
        {
            key: 'lines',
            type: 'list',
            label: 'Line items',
            required: true,
            fields: [
                { key: 'description', type: 'text', label: 'Description' },
                { key: 'amount', type: 'number', label: 'Amount', fields: [{ key: 'x', type: 'text' }] },
            ],
        },
        { key: 'tier', type: 'choice', options: ['gold', 3, 'silver'], default: 'gold', inferred: true },
        { key: 'weird', type: 'money' },
    ],
    sections: [
        { id: 'remote', title: 'Remote access', summary: 's', condition: { all: [{ parameter: 'remoteAccess', operator: 'equals', value: true }, 'junk'] }, parentId: null },
        { id: 'linked', title: 'Linked', source: { documentId: 'src', versionId: 'abcdef123' } },
    ],
    placeholders: [{ key: 'customer.name' }],
};

describe('readDocumentList', () => {
    it('reads the list rows and nothing else', () => {
        const [row] = readDocumentList({ documents: [ROW, null] });
        expect(row).toEqual({
            id: 'd1',
            name: 'Invoice 42',
            docType: 'invoice',
            description: '',
            kind: 'document',
            visibility: 'private',
            categories: ['sales'],
            versionId: 'v1',
            htmlSize: 1200,
            updatedAt: '2026-09-02T10:00:00Z',
        });
        expect(readDocumentList({ documents: 'nope' })).toEqual([]);
    });

    it('falls back on unknown kinds and visibilities', () => {
        const [row] = readDocumentList({ documents: [{ ...ROW, kind: 'x', visibility: 'public' }] });
        expect([row?.kind, row?.visibility]).toEqual(['document', 'private']);
    });
});

describe('readContract', () => {
    it('reads parameters, list fields one level deep, and sections', () => {
        const contract = readContract(CONTRACT);
        expect(contract.instructions).toBe('Use supplied figures.');
        expect(contract.parameters.map((p) => [p.key, p.type])).toEqual([
            ['customer.name', 'text'],
            ['lines', 'list'],
            ['tier', 'choice'],
            ['weird', 'text'],
        ]);
        expect(contract.parameters[1]?.fields?.map((f) => f.key)).toEqual(['description', 'amount']);
        expect(contract.parameters[1]?.fields?.[1]?.fields).toBeUndefined();
        expect(contract.parameters[2]).toMatchObject({ options: ['gold', 'silver'], default: 'gold', inferred: true });
        expect(contract.sections[0]?.condition).toEqual({ all: [{ parameter: 'remoteAccess', operator: 'equals', value: true }] });
        expect(contract.sections[1]).toMatchObject({ condition: null, source: { documentId: 'src', versionId: 'abcdef123' } });
    });

    it('reads nothing as an empty contract', () => {
        expect(readContract(null)).toEqual({ instructions: '', parameters: [], sections: [] });
    });
});

describe('readCondition', () => {
    it('keeps nesting and drops what it cannot read', () => {
        expect(readCondition({ any: [{ all: [{ parameter: 'a', operator: 'is_set' }] }, { operator: 'x' }] })).toEqual({
            any: [{ all: [{ parameter: 'a', operator: 'is_set' }] }],
        });
        expect(readCondition({ parameter: 'a', operator: 'bogus', value: 1 })).toEqual({ parameter: 'a', operator: 'equals', value: 1 });
        expect(readCondition(undefined)).toBeNull();
    });
});

describe('readDocument', () => {
    it('reads the slots, settings, editable and the served contract', () => {
        const doc = readDocument({ document: { ...ROW, bodyHtml: '<p>x</p>', css: 'p{}', settings: { houseStyle: false }, editable: false, contract: CONTRACT } });
        expect(doc).toMatchObject({ id: 'd1', bodyHtml: '<p>x</p>', css: 'p{}', settings: { houseStyle: false }, editable: false });
        expect(doc?.contract.parameters).toHaveLength(4);
    });

    it('keeps the previous editable, and falls back to the stored contract, when the answer has neither', () => {
        const doc = readDocument({ document: { ...ROW, settings: { contract: { parameters: [{ key: 'a', type: 'text' }] } } } }, { editable: false });
        expect(doc?.editable).toBe(false);
        expect(doc?.contract.parameters.map((p) => p.key)).toEqual(['a']);
    });

    it('is null without a document', () => {
        expect(readDocument({})).toBeNull();
        expect(readDocument(null)).toBeNull();
    });
});

describe('the small envelopes', () => {
    it('reads versions', () => {
        expect(readVersions({ versions: [{ id: 'v1', summary: 'Edited', createdAt: '2026-09-01' }, 4] })).toEqual([
            { id: 'v1', summary: 'Edited', createdAt: '2026-09-01' },
        ]);
    });

    it('reads starters with their parameter count', () => {
        expect(
            readStarters({ starters: [{ id: 'invoice', name: 'Invoice', docType: 'invoice', description: 'd', settings: { contract: { parameters: [{}, {}] } } }, null] }),
        ).toEqual([
            { id: 'invoice', name: 'Invoice', docType: 'invoice', description: 'd', parameterCount: 2 },
            { id: '', name: '', docType: 'document', description: '', parameterCount: 0 },
        ]);
        expect(readStarters({})).toEqual([]);
    });

    it('reads a validation verdict', () => {
        const result = readValidation({
            valid: false,
            issues: [{ code: 'required', key: 'total', message: 'Verified total is required' }],
            sections: [{ id: 'remote', title: 'Remote', state: 'unresolved', reason: 'Needs input: remoteAccess' }, { id: 'x', state: 'odd' }],
            bodyHtml: '<p>…</p>',
            html: '<html>…',
        });
        expect(result).toEqual({
            valid: false,
            issues: [{ code: 'required', key: 'total', message: 'Verified total is required', sectionId: undefined }],
            sections: [
                { id: 'remote', title: 'Remote', state: 'unresolved', reason: 'Needs input: remoteAccess' },
                { id: 'x', title: '', state: 'unresolved', reason: '' },
            ],
        });
    });
});
