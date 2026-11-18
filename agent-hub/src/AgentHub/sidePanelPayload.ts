// The side-panel part of a chat request body: which notebook, webpage or
// document the user has open, so the server can tell the AI what is on screen.

import { notebookIdOf } from '../pages/documents/notebookRef';

export interface SidePanelPayloadState {
    notebooksEnabled: boolean;
    showNotebook: boolean;
    notebookContent?: string;
    notebookSelection?: string;
    sidePanelWebpageId?: string | null;
    sidePanelWebpage?: { name?: string; description?: string } | null;
    sidePanelDocumentId?: string | null;
}

export function buildSidePanelPayload(s: SidePanelPayloadState): Record<string, unknown> {
    return {
        notebookspaceAvailable: s.notebooksEnabled,
        ...(s.showNotebook ? {
            notebookspaceContent: s.notebookContent || '',
            notebookspaceSelection: s.notebookSelection || '',
        } : {}),
        // Webpage side panel: metadata only; the server fetches html/css/js by id.
        ...(s.sidePanelWebpageId ? {
            sidePanelWebpage: {
                id: s.sidePanelWebpageId,
                ...(s.sidePanelWebpage?.name ? { name: s.sidePanelWebpage.name } : {}),
                ...(s.sidePanelWebpage?.description ? { description: s.sidePanelWebpage.description } : {}),
            },
        } : {}),
        // Document side panel: the AI reads only this document (or notebook).
        ...(s.sidePanelDocumentId ? { sidePanelDocument: panelDocument(s.sidePanelDocumentId) } : {}),
    };
}

/** A notebook open in the panel (`notebook/<id>`, notebookRef) goes as its own id, marked as one. */
function panelDocument(ref: string): { id: string; kind?: 'notebook' } {
    const notebookId = notebookIdOf(ref);
    return notebookId ? { id: notebookId, kind: 'notebook' } : { id: ref };
}
