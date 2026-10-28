import type { SseHandlerMap } from '../handlerTypes';
import { logger } from '@/utils/logger';

/**
 * Editor surfaces fed through the notebook callbacks (notebook, slides,
 * sheets, proposals) and the Documents DOM broadcasts.
 */
/** A chip of the user's message for this upload that has no document yet. */
function isUnlinkedUpload(a: unknown, fileName: string): a is Record<string, unknown> {
    return typeof a === 'object' && a !== null && 'name' in a && a.name === fileName && !('documentId' in a && a.documentId);
}

/** The attachments with `documentId` on the FIRST unlinked chip of that name: two uploads may share one. */
function linkFirst(attachments: unknown[], fileName: string, documentId: string): unknown[] {
    const at = attachments.findIndex((a) => isUnlinkedUpload(a, fileName));
    if (at === -1) return attachments;
    return attachments.map((a, i) => (i === at && isUnlinkedUpload(a, fileName) ? { ...a, documentId } : a));
}

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
        } catch (err) { logger.debug('DOM event dispatch failed, editor refreshes on next load', err); }
    },

    // An uploaded Excel was imported as a spreadsheet document: open it in the
    // right side panel (useSidePanelState listens; it skips phones itself),
    // and give the upload's chip its Open button now (`filename` is the
    // upload's name), not only after a reload brings the stored attachment.
    document_open(ctx, data, ids) {
        if (typeof data?.documentId !== 'string' || !data.documentId) return;
        const documentId = data.documentId;
        window.dispatchEvent(new CustomEvent('beeflow:open-document-side', {
            detail: { id: documentId, href: `/app/studio/documents/${documentId}` },
            cancelable: true,
        }));
        const fileName = data.filename;
        if (typeof fileName !== 'string' || !fileName) return;
        ctx.setMessages((prev) => prev.map((m) => (m.id === ids.userMsgId && Array.isArray(m.attachments)
            ? { ...m, attachments: linkFirst(m.attachments, fileName, documentId) }
            : m)));
    },

    // The AI proposed changes to a page instead of writing them: tell the
    // open editor's suggestions list (api/queries/suggestions.ts).
    document_suggestions(_ctx, data) {
        try {
            window.dispatchEvent(new CustomEvent('beeflow:document-suggestions', {
                detail: { documentId: data.documentId, batchId: data.batchId, count: data.count },
            }));
        } catch (err) { logger.debug('DOM event dispatch failed, editor refreshes on next load', err); }
    },
};
