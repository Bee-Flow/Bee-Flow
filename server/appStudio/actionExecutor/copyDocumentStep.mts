/**
 * App Studio action executor — copy_document: a copy of a Studio document in
 * the app OWNER's library, optionally wearing another presentation's look.
 *
 * The hook for "convert this presentation to the new template and show me
 * what changed": copy, then bind the result into a document_compare (left =
 * the source, right = the copy). What a conversion can do TODAY is the look
 * (settings.deck: preset, colours, fonts, the template deck, the logo); the
 * outline travels unchanged. A conversion between formats (a page into a
 * deck, an uploaded .pptx into an outline, an AI re-fit into a template's
 * slide structure) is a follow-up that plugs in here as a `mode`.
 *
 * WHOSE DOCUMENTS. The source and the template are read with every check a
 * document component's read gets (appDocuments/reader.mts loadForApp): as the
 * owner, the owner's own or an org team template, in the app's document pool
 * for this viewer's role (ctx.documentPool, built by the run route). The copy
 * is the owner's private library document, marked `createdByApp` so this app
 * (and only this app) may show it afterwards.
 *
 * A spreadsheet is refused: its cells live in datatables, and an app making
 * tables in the owner's name is a separate decision.
 */

import { createRequire } from 'node:module';
import { familyOf } from '../../core/documents/compare/index.mts';
import { AppDocumentError, loadForApp, type AppLike, type ReaderDeps, type StudioDoc } from '../appDocuments/reader.mts';
import { parseDocumentRef, type DocumentPool } from '../appDocuments/pool.mts';

const nodeRequire = createRequire(import.meta.url);

type StepResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: string; code?: string };

export interface CopyDeps {
    resolveBinding: (binding: unknown, ctx: Record<string, unknown>, scope: unknown) => unknown;
    buildServerScope: (ctx: Record<string, unknown>) => unknown;
    reader: Pick<ReaderDeps, 'getDocument' | 'getDocumentVersion'>;
    createDocument: (input: Record<string, unknown>) => Promise<StudioDoc & { description?: string }>;
}

/** A copy's name: one line, at most 200 characters. */
export function copyName(raw: unknown, fallback: string): string {
    const flat = String(raw ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    return flat || fallback.slice(0, 200);
}

/** The settings a copy starts from: the source's, minus what belongs to the source alone. */
export function copySettings(source: StudioDoc, appId: string): Record<string, unknown> {
    const settings: Record<string, unknown> = { ...(source.settings || {}) };
    for (const key of ['sampleValues', 'sectionOverrides', 'createdByApp', 'source', 'appliedTemplate', 'generatedFrom']) delete settings[key];
    return { ...settings, source: { documentId: source.id, versionId: source.versionId || null }, createdByApp: appId };
}

function realDeps(): CopyDeps {
    const shared = nodeRequire('./shared.js');
    const store = nodeRequire('../../stores/documentStore.js');
    return {
        resolveBinding: shared.resolveBinding,
        buildServerScope: shared.buildServerScope,
        reader: {
            getDocument: (id, userId) => store.getDocument(id, userId),
            getDocumentVersion: (id, userId, versionId) => store.getDocumentVersion(id, userId, versionId),
        },
        createDocument: (input) => store.createDocument(input),
    };
}

export async function copyDocumentStep(app: AppLike, _model: unknown, step: Record<string, unknown>, ctx: Record<string, unknown>, deps: CopyDeps = realDeps()): Promise<StepResult> {
    const pool = ctx.documentPool as DocumentPool | undefined;
    if (!pool || !(pool.ids instanceof Set)) return { ok: false, error: 'Documents are not available here', code: 'documents_unavailable' };
    const scope = deps.buildServerScope(ctx);
    const ref = parseDocumentRef(deps.resolveBinding(step.source, ctx, scope));
    if (!ref) return { ok: false, error: 'There is no document to copy', code: 'document_missing' };

    // Only the two reads the loader needs; the rest of the reader is for views.
    const reader = deps.reader as ReaderDeps;
    try {
        const source = await loadForApp(reader, app, pool, ref);
        if (familyOf(source.docType) === 'sheet') {
            return { ok: false, error: 'A spreadsheet cannot be copied by an app yet', code: 'sheet_copy_unavailable' };
        }
        const settings = copySettings(source, app.id);
        const templateId = typeof step.templateDocumentId === 'string' ? step.templateDocumentId.trim() : '';
        if (templateId) {
            const template = await loadForApp(reader, app, pool, { documentId: templateId, versionId: null });
            if (familyOf(source.docType) !== 'deck' || familyOf(template.docType) !== 'deck') {
                return { ok: false, error: 'A template look applies to presentations only', code: 'template_not_deck' };
            }
            const look = (template.settings || {}) as Record<string, unknown>;
            settings.deck = look.deck && typeof look.deck === 'object' ? look.deck : {};
            if (look.houseStyle === false) settings.houseStyle = false;
            else delete settings.houseStyle;
            settings.appliedTemplate = { documentId: template.id, versionId: template.versionId || null };
        }
        const doc = await deps.createDocument({
            userId: app.userId,
            name: copyName(deps.resolveBinding(step.name, ctx, scope), `${source.name} — copy`),
            kind: 'document',
            visibility: 'private',
            folderId: null,
            docType: source.docType,
            description: (source as { description?: string }).description || '',
            bodyHtml: source.bodyHtml || '',
            css: (source as { css?: string }).css || '',
            settings,
            categories: [],
        });
        return {
            ok: true,
            result: {
                kind: 'studio_document',
                documentId: doc.id,
                versionId: doc.versionId || null,
                name: doc.name,
                docType: doc.docType,
                sourceDocumentId: source.id,
                ...(templateId ? { templateDocumentId: templateId } : {}),
            },
        };
    } catch (e) {
        if (e instanceof AppDocumentError) return { ok: false, error: e.message, code: e.code };
        throw e;
    }
}
