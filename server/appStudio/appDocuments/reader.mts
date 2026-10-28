/**
 * Reading Studio documents for an app: load with every check, then shape what
 * the runtime gets (a view, picker options, the version list, a compare).
 *
 * WHO READS. The app's OWNER, acts-as-owner, exactly as fill_document does:
 * documentStore.getDocument(id, app.userId). A document the owner cannot
 * read and one that does not exist are the same 404, so an id is never an
 * oracle for whether somebody else's document exists.
 *
 * WHAT AN APP MAY SHOW, on top of that (checked in this order):
 *   1. Not archived, not a reusable section (a fragment, not a document).
 *   2. The owner's OWN document, or a team template of the app's organisation.
 *      A document merely shared WITH the owner (direct sharing, a project)
 *      is refused: an app's audience is wider than that share was.
 *   3. In the app's document pool (pool.mts) — or a copy this app made itself
 *      (settings.createdByApp, owned by the owner).
 *
 * WHAT LEAVES. Allow-listed fields only: id, name, type, family, revision,
 * last change. Never the owner's or an editor's user id, the organisation,
 * the project or the sharing list.
 *
 * Collaborators are injected (`ReaderDeps`): the tests run every check on
 * fakes, and the router wires the real stores and renderers.
 */

import { compareDocuments, familyOf, type CompareResult, type CompareSide, type Family } from '../../core/documents/compare/index.mts';
import type { AnyDeck } from '../../core/documents/compare/deckCompare.mts';
import type { SheetSide } from '../../core/documents/compare/sheetCompare.mts';
import { capFromEnv } from '../../core/documents/compare/limits.mts';
import { inPool, type DocumentPool, type DocumentRef } from './pool.mts';

export interface StudioDoc {
    id: string;
    userId: string;
    name: string;
    docType: string;
    kind?: string;
    visibility?: string;
    organizationId?: string | null;
    folderId?: string | null;
    archived?: boolean;
    bodyHtml?: string;
    settings?: Record<string, unknown> & { createdByApp?: unknown; houseStyle?: unknown };
    versionId?: string | null;
    updatedAt?: unknown;
    projectRole?: string;
    sharingRole?: string;
}
export interface ListedDoc { id: string; userId: string; name: string; docType: string; kind?: string; folderId?: string | null; updatedAt?: unknown; archived?: boolean }
export interface VersionRow { id: string; seq?: number | null; source?: string; name?: string | null; createdAt?: unknown }
export interface AppLike { id: string; userId: string; organizationId?: string | null }

export interface ReaderDeps {
    getDocument: (id: string, userId: string) => Promise<StudioDoc | null>;
    getDocumentVersion: (id: string, userId: string, versionId: string) => Promise<StudioDoc | null>;
    /** At most `limit` revisions, newest first (the real one pages through the store). */
    listVersions: (id: string, userId: string, opts: { limit: number }) => Promise<{ versions: VersionRow[] } | null>;
    /** At most `limit` documents of the folder, by name. */
    listFolder: (userId: string, folderId: string, limit: number) => Promise<ListedDoc[]>;
    readSheet: (doc: StudioDoc) => Promise<SheetSide>;
    previewHtml: (doc: StudioDoc, app: AppLike) => Promise<string>;
    deckOf: (doc: StudioDoc) => AnyDeck;
    lookOf: (doc: StudioDoc) => Record<string, unknown>;
}

export class AppDocumentError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const notFound = () => new AppDocumentError(404, 'document_not_found', 'This document is not available in this app.');

/** Kinds a picker can narrow to, by family. */
const PICKER_KINDS: Readonly<Record<string, Family | null>> = Object.freeze({ any: null, text: 'text', presentation: 'deck', spreadsheet: 'sheet' });
/**
 * The caps of an app's document reads: environment variables with a generous
 * default, 0 = unlimited, read on every call.
 *   STUDIO_APP_DOCUMENT_PICKER_OPTIONS  200  most documents one picker offers (a folder: the first by name)
 *   STUDIO_APP_DOCUMENT_VERSIONS        50   most revisions offered for a version compare
 *   STUDIO_APP_DOCUMENT_SHEET_TABS      30   most tabs of one spreadsheet read (appDocuments/deps.mts)
 */
export function appDocumentLimits(env: Record<string, string | undefined> = process.env): { pickerOptions: number; versions: number; sheetTabs: number } {
    return {
        pickerOptions: capFromEnv('STUDIO_APP_DOCUMENT_PICKER_OPTIONS', 200, env),
        versions: capFromEnv('STUDIO_APP_DOCUMENT_VERSIONS', 50, env),
        sheetTabs: capFromEnv('STUDIO_APP_DOCUMENT_SHEET_TABS', 30, env),
    };
}

/** Rule 1 and 2: may an app show this document at all? */
export function appMayShow(doc: StudioDoc | null, app: AppLike): doc is StudioDoc {
    if (!doc || doc.archived === true || doc.kind === 'section') return false;
    if (doc.userId === app.userId) return true;
    return doc.visibility === 'team' && doc.kind === 'template' && !doc.projectRole && !doc.sharingRole
        && !!doc.organizationId && doc.organizationId === (app.organizationId || null);
}

/** Rule 3: did the builder put it in this app, or did this app make it? */
export function inAppScope(doc: StudioDoc, app: AppLike, pool: DocumentPool): boolean {
    if (inPool(pool, doc, app.userId)) return true;
    return doc.userId === app.userId && doc.settings?.createdByApp === app.id;
}

/** Load one document (or one of its revisions) for the app, or throw 404. */
export async function loadForApp(deps: ReaderDeps, app: AppLike, pool: DocumentPool, ref: DocumentRef): Promise<StudioDoc> {
    const current = await deps.getDocument(ref.documentId, app.userId);
    if (!appMayShow(current, app) || !inAppScope(current, app, pool)) throw notFound();
    if (!ref.versionId || ref.versionId === current.versionId) return current;
    if (familyOf(current.docType) === 'sheet') {
        throw new AppDocumentError(422, 'sheet_versions_unavailable', 'A spreadsheet keeps no earlier versions of its cells to show.');
    }
    const version = await deps.getDocumentVersion(ref.documentId, app.userId, ref.versionId);
    if (!version) throw notFound();
    return version;
}

export interface DocumentMeta { id: string; name: string; docType: string; family: Family; versionId: string | null; updatedAt: unknown }

export function documentMeta(doc: StudioDoc): DocumentMeta {
    return {
        id: doc.id,
        name: doc.name,
        docType: doc.docType,
        family: familyOf(doc.docType),
        versionId: doc.versionId || null,
        updatedAt: doc.updatedAt ?? null,
    };
}

export interface SheetView { tabs: Array<{ name: string; display: Record<string, string> }> }
export interface DocumentView { document: DocumentMeta; html?: string; sheet?: SheetView }

/** What the viewer shows: the preview HTML, or the sheet's computed values. */
export async function documentView(deps: ReaderDeps, app: AppLike, doc: StudioDoc): Promise<DocumentView> {
    const document = documentMeta(doc);
    if (document.family === 'sheet') {
        const sheet = await deps.readSheet(doc);
        return { document, sheet: { tabs: sheet.tabs.map((t) => ({ name: t.name, display: t.display })) } };
    }
    return { document, html: await deps.previewHtml(doc, app) };
}

export interface PickerOption { id: string; name: string; docType: string; family: Family; updatedAt: unknown }

/** A picker's options: its own ids and folder, narrowed by kind and query, as the reader sees them. */
export async function pickerOptions(deps: ReaderDeps, app: AppLike, scope: { ids: string[]; folderId: string | null; kind: string }, query = ''): Promise<PickerOption[]> {
    const want = PICKER_KINDS[scope.kind] ?? null;
    const seen = new Map<string, PickerOption>();
    const add = (d: ListedDoc | StudioDoc) => {
        if (seen.has(d.id)) return;
        const family = familyOf(d.docType);
        if (want && family !== want) return;
        seen.set(d.id, { id: d.id, name: d.name, docType: d.docType, family, updatedAt: d.updatedAt ?? null });
    };
    for (const id of scope.ids) {
        const doc = await deps.getDocument(id, app.userId);
        if (appMayShow(doc, app)) add(doc);
    }
    const max = appDocumentLimits().pickerOptions;
    if (scope.folderId) {
        for (const d of await deps.listFolder(app.userId, scope.folderId, max)) {
            if (d.userId === app.userId && d.folderId === scope.folderId && !d.archived && d.kind !== 'section') add(d);
        }
    }
    const q = query.trim().toLowerCase();
    const list = [...seen.values()].filter((o) => !q || o.name.toLowerCase().includes(q));
    // The builder's own order for the listed ids, then the folder by name.
    return list.slice(0, max);
}

export interface VersionOption { versionId: string; label: string | null; source: string; createdAt: unknown; current: boolean }

/** A document's revisions, newest first, for a version compare. */
export async function documentVersions(deps: ReaderDeps, app: AppLike, doc: StudioDoc): Promise<{ supported: boolean; versions: VersionOption[] }> {
    if (familyOf(doc.docType) === 'sheet') return { supported: false, versions: [] };
    const page = await deps.listVersions(doc.id, app.userId, { limit: appDocumentLimits().versions });
    const versions = (page?.versions || []).map((v) => ({
        versionId: v.id,
        // A person's name for a version is the document's own text; who made it is not sent.
        label: typeof v.name === 'string' && v.name ? v.name : null,
        source: v.source || 'legacy',
        createdAt: v.createdAt ?? null,
        current: v.id === doc.versionId,
    }));
    return { supported: true, versions };
}

function emptyDeck(doc: StudioDoc): AnyDeck {
    return { title: doc.name, subtitle: null, slides: [] };
}

async function sideOf(deps: ReaderDeps, doc: StudioDoc): Promise<CompareSide> {
    const family = familyOf(doc.docType);
    if (family === 'sheet') return { docType: doc.docType, sheet: await deps.readSheet(doc) };
    if (family === 'deck') {
        let deck: AnyDeck;
        // An empty presentation has no slides to compare, which is an answer, not an error.
        try { deck = deps.deckOf(doc); } catch (e) {
            if ((e as { errorClass?: string })?.errorClass !== 'document_empty') throw e;
            deck = emptyDeck(doc);
        }
        return { docType: doc.docType, bodyHtml: doc.bodyHtml || '', deck, look: deps.lookOf(doc), houseStyle: doc.settings?.houseStyle !== false };
    }
    return { docType: doc.docType, bodyHtml: doc.bodyHtml || '' };
}

export interface AppCompare {
    left: DocumentMeta;
    right: DocumentMeta;
    result: CompareResult;
    /** Decks only: both rendered, for the side-by-side slides. */
    leftHtml?: string | null;
    rightHtml?: string | null;
}

/** Compare two loaded documents; decks also come back rendered. */
export async function compareForApp(deps: ReaderDeps, app: AppLike, left: StudioDoc, right: StudioDoc): Promise<AppCompare> {
    const result = compareDocuments(await sideOf(deps, left), await sideOf(deps, right));
    const out: AppCompare = { left: documentMeta(left), right: documentMeta(right), result };
    if (result.family === 'deck') {
        // A deck that cannot be drawn still compares as text; the panes then say so.
        const render = (doc: StudioDoc) => deps.previewHtml(doc, app).catch(() => null);
        out.leftHtml = await render(left);
        out.rightHtml = await render(right);
    }
    return out;
}
