/**
 * The reader's collaborators over the real stores and renderers (reader.mts
 * takes them injected so its checks are tested on fakes). Everything is
 * required on first use: loading the router must not load jsdom, the deck
 * renderer or the datatable runtime.
 *
 * The preview HTML is the Studio editor's own (routes/studioDocuments.js
 * previewHtmlFor), with the APP's context instead of a session: the app's
 * organisation decides the house style, and pictures resolve as the OWNER's
 * (the fill_document rule: an app prints on the company's paper). It is
 * served as JSON and drawn in a sandboxed srcDoc frame; the CSP below rides
 * inside the document because a srcDoc frame has no response headers.
 */

import { createRequire } from 'node:module';
import type { AnyDeck } from '../../core/documents/compare/deckCompare.mts';
import type { SheetSide } from '../../core/documents/compare/sheetCompare.mts';
import { appDocumentLimits, type AppLike, type ListedDoc, type ReaderDeps, type StudioDoc, type VersionRow } from './reader.mts';

const nodeRequire = createRequire(import.meta.url);

/** The Studio preview's CSP (routes/studioDocuments.js PREVIEW_CSP), as a meta tag. */
const PREVIEW_CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'";

/** The CSP as the first thing in <head> (or in front of everything when there is none). */
export function withCsp(html: string): string {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`) : `${meta}${html}`;
}

const EMPTY_DECK_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif;color:#666"><p data-deck-empty="1"></p></body></html>';

interface DocumentStore {
    getDocument: (id: string, userId: string) => Promise<StudioDoc | null>;
    getDocumentVersion: (id: string, userId: string, versionId: string) => Promise<StudioDoc | null>;
    listVersions: (id: string, userId: string, opts: { limit: number; cursor?: string | null }) => Promise<{ versions: VersionRow[]; nextCursor?: string | null } | null>;
    listDocuments: (userId: string, opts: Record<string, unknown>) => Promise<ListedDoc[]>;
}

const store = () => nodeRequire('../../stores/documentStore.js') as DocumentStore;

async function previewHtml(doc: StudioDoc, app: AppLike): Promise<string> {
    const orgId = app.organizationId || null;
    const { isDeckDocument, renderDeckDocument } = nodeRequire('../../core/documents/deckDocument.js');
    if (isDeckDocument(doc)) {
        const { makeUserImageResolver } = nodeRequire('../../services/presentationRenderer.js');
        try {
            const out = await renderDeckDocument({ document: doc, format: 'html', orgId, resolveImage: makeUserImageResolver(app.userId), assertFilled: false });
            return withCsp(String(out.html || ''));
        } catch (e) {
            if ((e as { errorClass?: string })?.errorClass === 'document_empty') return withCsp(EMPTY_DECK_HTML);
            throw e;
        }
    }
    const { composeDocument } = nodeRequire('../../services/documentCompose.js');
    const { forCompose } = nodeRequire('../../core/documents/pageDocument.js');
    const { houseStyleCssFor } = nodeRequire('../../core/documents/renderFilledDocument.js');
    return withCsp(String(composeDocument(forCompose(doc), { mode: 'print', houseStyleCss: await houseStyleCssFor(doc, orgId) })));
}

/** Every tab's raw cells and what each cell shows (formulas computed across tabs). */
async function readSheet(doc: StudioDoc): Promise<SheetSide> {
    const { sheetTabsOf } = nodeRequire('../../stores/lib/sheetDocument.js');
    const cells = nodeRequire('../../core/documents/sheetCells.js');
    const { evaluateSheet } = nodeRequire('../../shared/expr/sheet.mjs');
    const tabs = (sheetTabsOf(doc) as Array<{ name: string; datatableId: string }>).slice(0, appDocumentLimits().sheetTabs);
    const workbook: Record<string, Record<string, string>> = {};
    for (const t of tabs) workbook[t.name] = (await cells.readSheet(doc.userId, t.datatableId)).cells || {};
    return {
        tabs: tabs.map((t) => {
            const shown = evaluateSheet(workbook[t.name], { workbook, activeSheet: t.name }) as Record<string, { display?: string }>;
            const display: Record<string, string> = {};
            for (const [name, r] of Object.entries(shown)) if (r && r.display) display[name] = String(r.display);
            return { name: t.name, cells: workbook[t.name], display };
        }),
    };
}

/** The store answers at most this many rows per call; longer lists are read page by page. */
const STORE_PAGE = { documents: 200, versions: 100 };

/** A folder's documents by name, page by page, up to `limit` (Infinity = all). */
async function listFolder(userId: string, folderId: string, limit: number): Promise<ListedDoc[]> {
    const out: ListedDoc[] = [];
    while (out.length < limit) {
        const size = Math.min(STORE_PAGE.documents, limit - out.length);
        const page = await store().listDocuments(userId, { folderId, limit: size, offset: out.length, sort: 'name' });
        out.push(...page);
        if (page.length < size) break;
    }
    return out;
}

/** A document's revisions, newest first, page by page, up to `limit` (Infinity = all). */
async function listVersions(id: string, userId: string, { limit }: { limit: number }): Promise<{ versions: VersionRow[] } | null> {
    const versions: VersionRow[] = [];
    let cursor: string | null = null;
    while (versions.length < limit) {
        const page = await store().listVersions(id, userId, { limit: Math.min(STORE_PAGE.versions, limit - versions.length), cursor });
        if (!page) return versions.length ? { versions } : null;
        versions.push(...page.versions);
        cursor = page.nextCursor || null;
        if (!cursor) break;
    }
    return { versions };
}

export function realReaderDeps(): ReaderDeps {
    return {
        getDocument: (id, userId) => store().getDocument(id, userId),
        getDocumentVersion: (id, userId, versionId) => store().getDocumentVersion(id, userId, versionId),
        listVersions,
        listFolder,
        readSheet,
        previewHtml,
        deckOf: (doc) => nodeRequire('../../core/documents/deckDocument.js').deckFromDocument(doc).deck as AnyDeck,
        lookOf: (doc) => nodeRequire('../../core/documents/deckDocument.js').deckOverridesOf(doc) as Record<string, unknown>,
    };
}
