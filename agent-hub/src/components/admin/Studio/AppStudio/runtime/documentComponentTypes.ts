import { FileSearch, FileText, GitCompare } from 'lucide-react';
import AppDocumentCompare from './components/AppDocumentCompare';
import AppDocumentViewer from './components/AppDocumentViewer';
import AppInputDocument from './components/AppInputDocument';
import type { RegistryEntry } from './componentRegistry.types';

/**
 * The registry entries of the Studio-document components (spec:
 * server/appStudio/componentSpecs/documentSpecs.js), spread into
 * APP_COMPONENT_TYPES. catalogLockstep.test.js pins them against the spec.
 */
export const DOCUMENT_COMPONENT_TYPES: Record<string, RegistryEntry> = {
    document_viewer: {
        Component: AppDocumentViewer, label: 'Document', icon: FileText, category: 'Content',
        defaultProps: { source: { kind: 'static', value: null }, emptyText: 'No document selected.', showHeader: true },
        defaultStyle: { span: 12, height: 'lg' },
    },
    document_compare: {
        Component: AppDocumentCompare, label: 'Document compare', icon: GitCompare, category: 'Content',
        defaultProps: {
            left: { kind: 'static', value: null }, right: { kind: 'static', value: null },
            leftLabel: 'Before', rightLabel: 'After', mode: 'side', onlyChanges: true, emptyText: 'No documents to compare.',
        },
        defaultStyle: { span: 12, height: 'xl' },
    },
    input_document: {
        Component: AppInputDocument, label: 'Document picker', icon: FileSearch, category: 'Input', isInput: true,
        defaultProps: { name: 'document', label: 'Document', kind: 'any', documentIds: [], folderId: null, required: false },
        defaultStyle: { span: 6 },
    },
};
