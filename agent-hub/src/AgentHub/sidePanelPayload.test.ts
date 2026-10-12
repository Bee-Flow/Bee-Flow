import { describe, expect, it } from 'vitest';
import { buildSidePanelPayload } from './sidePanelPayload';

const base = { notebooksEnabled: true, showNotebook: false };

describe('buildSidePanelPayload', () => {
    it('sends sidePanelDocument only while a document is open', () => {
        expect(buildSidePanelPayload(base)).not.toHaveProperty('sidePanelDocument');
        expect(buildSidePanelPayload({ ...base, sidePanelDocumentId: null })).not.toHaveProperty('sidePanelDocument');
        expect(buildSidePanelPayload({ ...base, sidePanelDocumentId: 'd1' }).sidePanelDocument).toEqual({ id: 'd1' });
    });

    it('keeps the notebook and webpage parts', () => {
        const p = buildSidePanelPayload({
            ...base, showNotebook: true, notebookContent: 'hi',
            sidePanelWebpageId: 'w1', sidePanelWebpage: { name: 'Home' },
        });
        expect(p).toMatchObject({
            notebookspaceAvailable: true, notebookspaceContent: 'hi', notebookspaceSelection: '',
            sidePanelWebpage: { id: 'w1', name: 'Home' },
        });
    });
});
