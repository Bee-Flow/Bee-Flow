/**
 * The Documents API as a Fill in a document step reads it: the paths and
 * query strings, what the readers keep of a template row and a contract, and
 * — TEXTUAL — the server source that serves both, so a moved route or a
 * renamed contract field goes red here rather than on a phone.
 */

import fs from 'node:fs';
import path from 'node:path';

import { api } from '@/core/api/client';

import { documentKeys, getDocumentContract, listDocumentTemplates, readDocumentContract, readDocumentTemplates } from './documents';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
beforeEach(() => get.mockReset());

const REPO = path.resolve(__dirname, '../../../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('the calls', () => {
    it('lists up to 200 templates, searching only when there is something to search for', async () => {
        get.mockResolvedValue({ templates: [] });
        await listDocumentTemplates('');
        await listDocumentTemplates('offerte');
        expect(get.mock.calls).toEqual([
            ['/api/studio-documents/templates', { signal: undefined, query: { limit: '200' } }],
            ['/api/studio-documents/templates', { signal: undefined, query: { limit: '200', query: 'offerte' } }],
        ]);
    });

    it('reads a contract at a revision, or as the document is now', async () => {
        get.mockResolvedValue({ contract: {} });
        await getDocumentContract('d 1', 'baseline');
        await getDocumentContract('d1', null);
        expect(get.mock.calls).toEqual([
            ['/api/studio-documents/d%201/contract', { signal: undefined, query: { versionId: 'baseline' } }],
            ['/api/studio-documents/d1/contract', { signal: undefined }],
        ]);
    });

    it('keys the current contract apart from any pinned one', () => {
        expect(documentKeys.contract('d1', null)).not.toEqual(documentKeys.contract('d1', 'baseline'));
        expect(documentKeys.templates('a')).not.toEqual(documentKeys.templates(''));
    });
});

describe('the readers', () => {
    it('keeps a template’s parameters and placeholders apart, and drops rows with no id', () => {
        const list = readDocumentTemplates({
            templates: [
                {
                    id: 'd1',
                    name: 'Invoice',
                    docType: 'invoice',
                    versionId: 'v1',
                    bodyHtml: '<p>secret layout</p>',
                    parameters: [{ key: 'lines', type: 'list', label: 'Lines', fields: [{ key: 'qty', type: 'number' }] }, { label: 'no key' }],
                    placeholders: [{ key: 'lines', kind: 'list', fields: ['qty'] }],
                },
                { name: 'No id' },
                { id: 'd2', name: 'Letter' },
            ],
        });
        expect(list.map((d) => d.id)).toEqual(['d1', 'd2']);
        expect(list[0]).toEqual({
            id: 'd1',
            name: 'Invoice',
            docType: 'invoice',
            versionId: 'v1',
            parameters: [{ key: 'lines', label: 'Lines', type: 'list', kind: '', required: false, summary: '', instructions: '', fields: ['qty'] }],
            placeholders: [{ key: 'lines', label: '', type: '', kind: 'list', required: false, summary: '', instructions: '', fields: ['qty'] }],
        });
        // A server that sends neither list: neither is claimed to be empty.
        expect(list[1]).toEqual({ id: 'd2', name: 'Letter', docType: '', versionId: '' });
        expect(readDocumentTemplates(null)).toEqual([]);
    });

    it('reads a contract, keeping an example of any shape and nothing it does not use', () => {
        const contract = readDocumentContract({
            contract: {
                documentId: 'd1',
                versionId: 'v2',
                name: 'Quote',
                docType: 'presentation',
                instructions: 'Fill every line.',
                parameters: [{ key: 'total', type: 'number', required: true, example: { amount: 1 } }],
                sections: [{ id: 'terms', title: 'Terms', summary: 'Only for new clients', condition: { parameter: 'new' } }, { title: 'no id' }],
            },
        });
        expect(contract).toEqual({
            documentId: 'd1',
            versionId: 'v2',
            name: 'Quote',
            docType: 'presentation',
            instructions: 'Fill every line.',
            parameters: [{ key: 'total', label: '', type: 'number', kind: '', required: true, summary: '', instructions: '', example: { amount: 1 }, fields: [] }],
            sections: [{ id: 'terms', title: 'Terms', summary: 'Only for new clients' }],
        });
        expect(readDocumentContract({}).parameters).toEqual([]);
    });
});

describe('the server that answers (TEXTUAL)', () => {
    it('mounts the router at /api/studio-documents', () => {
        expect(read('server/index.js')).toContain("app.use('/api/studio-documents', require('./routes/studioDocuments'))");
    });

    it('serves { templates } and { contract }, with `baseline` meaning the pinned-less revision', () => {
        const src = read('server/routes/studioDocuments.js');
        expect(src).toContain("router.get('/templates'");
        expect(src).toContain('res.json({ templates })');
        expect(src).toContain("router.get('/:id/contract'");
        expect(src).toContain('res.json({ contract:getContract(doc) })');
        expect(src).toContain("req.query.versionId === 'baseline' ? undefined : req.query.versionId");
        expect(src).toMatch(/Math\.min\(Math\.max\(parseInt\(req\.query\.limit, 10\) \|\| 50, 1\), 200\)/);
    });

    it('spreads the contract onto every template row, placeholders included', () => {
        expect(read('server/stores/documentStore.js')).toContain('return { ...d, ...getContract(doc), placeholders: getContract(doc).placeholders };');
    });

    it('still names the contract fields the phone reads', () => {
        const src = read('server/core/documents/documentContract.js');
        for (const f of ['key: p.key, type: p.type, label:', 'required: p.required === true', 'summary:', 'instructions:', 'fields: (p.fields || [])']) expect(src).toContain(f);
        expect(src).toContain('return { id: s.id, title:');
        expect(src).toContain('return { ...explicit, parameters, placeholders, documentId: doc.id, versionId: doc.versionId,');
        expect(src).toContain('name: doc.name, docType: doc.docType');
    });

    it('is the list the web’s picker asks for, 200 at a time', () => {
        const web = read('agent-hub/src/components/automation/Builder/flow/settings/actionEditors/documentFields.jsx');
        expect(web).toContain('listTemplates({query,limit:200})');
        expect(read('agent-hub/src/pages/documents/documentsApi.js')).toContain('`${BASE}/templates${');
    });
});
