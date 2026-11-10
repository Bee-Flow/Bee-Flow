import { FileSearch, FileText, GitCompare } from 'lucide-react';
import AppDocumentCompare from './components/AppDocumentCompare';
import AppDocumentViewer from './components/AppDocumentViewer';
import AppInputDocument from './components/AppInputDocument';
import type { ComponentRenderer } from './componentRegistry.types';

/**
 * The renderers and icons of the Studio-document components (spec:
 * server/appStudio/componentSpecs/documentSpecs.js), spread into
 * APP_COMPONENT_TYPES. Their palette data comes from the catalog snapshot.
 */
export const DOCUMENT_COMPONENT_TYPES: Record<string, ComponentRenderer> = {
    document_viewer: { Component: AppDocumentViewer, icon: FileText },
    document_compare: { Component: AppDocumentCompare, icon: GitCompare },
    input_document: { Component: AppInputDocument, icon: FileSearch },
};
