import type { SseHandlerMap } from '../handlerTypes';

/**
 * Editor surfaces fed through the notebook callbacks (notebook, slides,
 * sheets, proposals) and the Documents DOM broadcasts.
 */
export const notebookHandlers: SseHandlerMap = {
    workspace_update(ctx, data) {
        const { onNotebookUpdate } = ctx;
        onNotebookUpdate?.(data.content);
    },

    notebook_doc_update(ctx, data) {
        const { onNotebookDocUpdateRef } = ctx;
        // `version` rides along so the page can resync its CAS counter
        // (AI doc writes bump the notebook version server-side).
        onNotebookDocUpdateRef.current?.(data.content, data.title, data.version);
    },

    // Slides-specific aliases (same callbacks as notebook)
    slides_deck_update(ctx, data) {
        const { onNotebookDocUpdateRef } = ctx;
        onNotebookDocUpdateRef.current?.(data.slides, data.title);
    },

    slides_theme_update(ctx, data) {
        const { onNotebookThemeUpdateRef } = ctx;
        onNotebookThemeUpdateRef.current?.(data.theme);
    },

    notebook_source_added(ctx, data) {
        const { onNotebookSourceAddedRef } = ctx;
        onNotebookSourceAddedRef.current?.(data.source);
    },

    slides_source_added(ctx, data) {
        const { onNotebookSourceAddedRef } = ctx;
        onNotebookSourceAddedRef.current?.(data.source);
    },

    // Sheet-specific aliases (same callbacks as notebook/slides)
    sheet_update(ctx, data) {
        const { onNotebookDocUpdateRef } = ctx;
        onNotebookDocUpdateRef.current?.(data.cells, data.sheetIndex);
    },

    sheet_source_added(ctx, data) {
        const { onNotebookSourceAddedRef } = ctx;
        onNotebookSourceAddedRef.current?.(data.source);
    },

    // Proposal-specific aliases
    proposal_blocks_update(ctx, data) {
        const { onNotebookDocUpdateRef } = ctx;
        onNotebookDocUpdateRef.current?.(data.blocks);
    },

    // The AI created or rewrote a Document. Re-broadcast as a DOM event
    // (the webpage_db_update idiom in ./webpage.ts) so an open Documents list or
    // editor refreshes itself, without drilling a callback through the
    // chat → Studio → editor prop chain.
    document_update(_ctx, data) {
        try {
            window.dispatchEvent(new CustomEvent('beeflow:document-updated', {
                detail: { documentId: data.documentId, name: data.name, url: data.url },
            }));
        } catch (_) {}
    },

    // The AI proposed changes to a page instead of writing them: tell the
    // open editor's suggestions list (api/queries/suggestions.ts).
    document_suggestions(_ctx, data) {
        try {
            window.dispatchEvent(new CustomEvent('beeflow:document-suggestions', {
                detail: { documentId: data.documentId, batchId: data.batchId, count: data.count },
            }));
        } catch (_) {}
    },
};
