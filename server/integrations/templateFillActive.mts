/**
 * Which document a conversation is filling in, kept on the document itself.
 *
 * template_fill_start writes `settings.templateFill = { conversationId,
 * templateId, startedAt }` on the copy it makes; finishing adds `finishedAt`.
 * A later turn finds its document again from that link, so the fill does not
 * depend on the model still holding the id (older tool results reach a later
 * turn only as a short preview, and sometimes not at all).
 *
 * Only the caller's OWN documents count: the document's owner is the person
 * who started the fill, and the link names this conversation. The settings
 * are stored sealed (stores/documentStore.js), so the link is read per
 * document, never queried in SQL: first the documents this chat already has
 * in scope, then the caller's most recently changed documents.
 */

import { isObject, type TemplateDoc } from '../core/documents/templateValues.mts';

export type FillLink = { conversationId: string, templateId: string, startedAt: string, finishedAt?: string };
export type ActiveFillStore = {
    /** A project's documents (a team chat's fills live there); absent in a store that only knows a person's own. */
    listProjectDocuments?: (projectId: string, options: { limit?: number }) => Promise<Array<{ id: string }>>,
    getDocument: (id: string, userId: string) => Promise<TemplateDoc | null>,
    listDocuments: (userId: string, options: { kind: string, query?: string, limit: number, sort?: string }) => Promise<TemplateDoc[]>,
};
export type FillScope = { has: (id: string) => boolean, ids?: () => string[], add?: (id: string) => void, markCreated?: (id: string) => void };

const RECENT_LOOKED_AT = 10;
/** A project holds more documents than one person changes at once: look a little further. */
const PROJECT_LOOKED_AT = 30;

/** The link a new fill carries. */
export function newFillLink(conversationId: string, templateId: string, now: Date = new Date()): FillLink {
    return { conversationId, templateId, startedAt: now.toISOString() };
}

/** The document's link to a conversation, or null. */
export function fillLinkOf(doc: TemplateDoc | null | undefined): FillLink | null {
    const link = doc?.settings?.templateFill;
    if (!isObject(link) || typeof link.conversationId !== 'string' || typeof link.templateId !== 'string') return null;
    return {
        conversationId: link.conversationId, templateId: link.templateId,
        startedAt: typeof link.startedAt === 'string' ? link.startedAt : '',
        ...(typeof link.finishedAt === 'string' ? { finishedAt: link.finishedAt } : {}),
    };
}

/** Whether this is the caller's own document, filled in by this conversation. */
export function isLinkedTo(doc: TemplateDoc | null, conversationId: string | null | undefined, userId: string, projectId?: string | null): boolean {
    const link = fillLinkOf(doc);
    // In a project's team chat the fill is the project's: every member who may read it goes on with it.
    const whose = projectId ? (doc as { projectId?: string | null } | null)?.projectId === projectId : doc?.userId === userId;
    return !!doc && !!conversationId && whose && (doc.kind ?? 'document') === 'document' && link?.conversationId === conversationId;
}

/** The settings with the fill marked finished. */
export function finishedSettings(doc: TemplateDoc, now: Date = new Date()): Record<string, unknown> {
    const link = fillLinkOf(doc);
    return link ? { ...(doc.settings || {}), templateFill: { ...link, finishedAt: now.toISOString() } } : { ...(doc.settings || {}) };
}

type Want = { conversationId: string | null | undefined, userId: string, templateId?: string, projectId?: string | null };

const isActive = (doc: TemplateDoc | null, want: Want): doc is TemplateDoc => {
    if (!isLinkedTo(doc, want.conversationId, want.userId, want.projectId)) return false;
    const link = fillLinkOf(doc);
    return !!link && !link.finishedAt && (!want.templateId || link.templateId === want.templateId);
};

/** The most recently started of the active fills among these ids. */
async function newestAmong(store: ActiveFillStore, ids: Iterable<string>, want: Want, seen: Set<string>): Promise<TemplateDoc | null> {
    let best: TemplateDoc | null = null;
    for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const doc = await store.getDocument(id, want.userId);
        if (!isActive(doc, want)) continue;
        if (!best || (fillLinkOf(doc)?.startedAt || '') > (fillLinkOf(best)?.startedAt || '')) best = doc;
    }
    return best;
}

/**
 * The unfinished fill this conversation started most recently (of `templateId`
 * when given), or null. A document found is put in the chat's scope, as the
 * chat's own: it made it.
 */
export async function findActiveFill(store: ActiveFillStore, scope: FillScope | null | undefined, want: Want): Promise<TemplateDoc | null> {
    if (!want.conversationId) return null;
    const seen = new Set<string>();
    let found = await newestAmong(store, typeof scope?.ids === 'function' ? scope.ids() : [], want, seen);
    if (!found) {
        const recent = want.projectId && store.listProjectDocuments
            ? await store.listProjectDocuments(want.projectId, { limit: PROJECT_LOOKED_AT })
            : await store.listDocuments(want.userId, { kind: 'document', limit: RECENT_LOOKED_AT, sort: 'updated' });
        found = await newestAmong(store, recent.map((d) => d.id), want, seen);
    }
    if (found) {
        if (scope?.markCreated) scope.markCreated(found.id);
        else scope?.add?.(found.id);
    }
    return found;
}
