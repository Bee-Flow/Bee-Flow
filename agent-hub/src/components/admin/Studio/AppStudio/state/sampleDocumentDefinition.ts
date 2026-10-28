/**
 * App Studio — the fixture for the Studio-document components (document_viewer,
 * document_compare, input_document), beside the ones in sampleDefinitions.ts:
 * a picker in a form, a viewer bound to it and a compare. Static nulls and a
 * design-time render mean nothing is fetched.
 */
import type { AppDefinition } from '../inspector/appDefinition';

export const DOCUMENTS_SAMPLE: AppDefinition = Object.freeze({
    schemaVersion: 2,
    meta: { name: 'Documents', description: 'Studio documents in an app.', icon: 'FileText' },
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
    homeScreenId: 'scr_docs01',
    roles: [],
    screens: [{
        id: 'scr_docs01', name: 'Documents', icon: 'FileText', showInNav: true, maxWidth: 'wide',
        sections: [{
            id: 'sec_docs01', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_docform', type: 'form', visible: true, props: { name: 'docs', submitLabel: 'Show', showReset: false }, style: { span: 12, gap: 3, padding: 0 },
                    children: [
                        { id: 'cmp_docpick', type: 'input_document', visible: true, props: { name: 'document', label: 'Document', kind: 'any', documentIds: ['doc_a'], folderId: null, required: false }, style: { span: 6, size: 'md' } },
                    ],
                },
                { id: 'cmp_docview', type: 'document_viewer', visible: true, props: { source: { kind: 'static', value: null }, emptyText: 'No document selected.', showHeader: true }, style: { span: 12, height: 'lg' } },
                {
                    id: 'cmp_doccmp', type: 'document_compare', visible: true,
                    props: { left: { kind: 'static', value: null }, right: { kind: 'static', value: null }, leftLabel: 'Before', rightLabel: 'After', mode: 'side', onlyChanges: true, emptyText: 'No documents to compare.' },
                    style: { span: 12, height: 'xl' },
                },
            ],
        }],
    }],
    actions: {},
} as AppDefinition);
