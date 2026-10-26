// Studio documents inside an App Studio app (server/routes/studioAppDocuments.js):
// the picker's options, one document read-only, its versions, and the compare.
// Every call names the component that shows the document (`node`); the server
// decides from that, the viewer's role and the app's document pool what may be
// read. A refusal arrives as RefusedError; `documentErrorCode` reads its code.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, errorBody, request, RefusedError } from '../mutate';

export type DocumentFamily = 'text' | 'deck' | 'sheet';

interface AppDocumentMeta {
    id: string;
    name: string;
    docType: string;
    family: DocumentFamily;
    versionId: string | null;
    updatedAt: string | null;
}
export interface AppDocumentOption { id: string; name: string; docType: string; family: DocumentFamily; updatedAt: string | null }
interface AppSheetTab { name: string; display: Record<string, string> }
export interface AppDocumentView { document: AppDocumentMeta; html?: string; sheet?: { tabs: AppSheetTab[] } }
export interface AppDocumentVersion { versionId: string; label: string | null; source: string; createdAt: string | null; current: boolean }

// ── The compare's answer (core/documents/compare) ─────────────────────

type WordOp = 'equal' | 'insert' | 'delete';
interface DiffWord { op: WordOp; text: string }
export interface DiffLine { op: 'equal' | 'insert' | 'delete' | 'modify'; before?: string; after?: string; words?: DiffWord[] }
interface AstNode { type: string; attrs?: Record<string, unknown>; content?: AstNode[]; marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; text?: string }
interface TextBlock { op: 'equal' | 'insert' | 'delete' | 'modify'; before?: AstNode; after?: AstNode; words?: DiffWord[]; formatOnly?: boolean }

export interface TextCompare {
    family: 'text';
    blocks: TextBlock[];
    truncated: boolean;
    summary: { changed: number; added: number; removed: number; unchanged: number; wordsAdded: number; wordsRemoved: number };
}
interface SlideHead { index: number; title: string; layout: string }
export interface SlidePair { op: 'equal' | 'changed' | 'added' | 'removed'; left: SlideHead | null; right: SlideHead | null; layoutChanged: boolean; lines: DiffLine[]; wordsAdded: number; wordsRemoved: number }
export interface LookChange { key: string; before: string; after: string; replaced?: boolean }
export interface DeckCompare {
    family: 'deck';
    slides: SlidePair[];
    look: LookChange[];
    summary: { changed: number; added: number; removed: number; unchanged: number; lookChanged: boolean; wordsAdded: number; wordsRemoved: number };
}
export interface ColumnPair { left: string | null; right: string | null; header: string; op: 'equal' | 'added' | 'removed' }
export interface CellChange { col: number; op: 'changed' | 'added' | 'removed'; before: string; after: string; beforeFormula?: string; afterFormula?: string }
export interface RowPair { op: 'equal' | 'changed' | 'added' | 'removed'; left: number | null; right: number | null; before: string[]; after: string[]; cells: CellChange[] }
export interface TabCompare {
    name: string;
    leftName: string | null;
    rightName: string | null;
    op: 'equal' | 'changed' | 'added' | 'removed';
    columns: ColumnPair[];
    rows: RowPair[];
    hiddenRows: number;
    stats: { cellsChanged: number; rowsAdded: number; rowsRemoved: number; columnsAdded: number; columnsRemoved: number };
}
export interface SheetCompare {
    family: 'sheet';
    tabs: TabCompare[];
    summary: { tabsChanged: number; tabsAdded: number; tabsRemoved: number; cellsChanged: number; rowsAdded: number; rowsRemoved: number; columnsAdded: number; columnsRemoved: number };
}
export type CompareResult = TextCompare | DeckCompare | SheetCompare;
export interface AppDocumentCompare {
    left: AppDocumentMeta;
    right: AppDocumentMeta;
    result: CompareResult;
    leftHtml?: string | null;
    rightHtml?: string | null;
}

/** A side of a compare: a document, and a revision of it (null = as it is now). */
export interface DocumentRef { documentId: string; versionId: string | null }

/** The machine-readable code of a refused read, or null. */
export function documentErrorCode(error: unknown): string | null {
    if (!(error instanceof RefusedError)) return null;
    const body = errorBody(error) as { code?: unknown } | null;
    return typeof body?.code === 'string' ? body.code : null;
}

const base = (appId: string) => `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/documents`;
const qs = (params: Record<string, string | null | undefined | false>) => {
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) out.set(k, v);
    return out.toString();
};

async function json<T>(url: string, init?: Parameters<typeof request>[1]): Promise<T> {
    const res = init === undefined ? await request(url) : await request(url, init);
    return (await res.json()) as T;
}

interface Scope { appId: string | null; nodeId: string; draft: boolean; enabled: boolean }

/** The options of an input_document. */
export function useAppDocumentOptions({ appId, nodeId, draft, enabled }: Scope) {
    return useQuery<AppDocumentOption[], Error>({
        queryKey: ['studio-app-documents', 'options', appId, nodeId, draft],
        enabled: enabled && !!appId,
        queryFn: async () => (await json<{ documents: AppDocumentOption[] }>(`${base(appId as string)}?${qs({ node: nodeId, draft: draft && '1' })}`)).documents || [],
        staleTime: 30_000,
        retry: false,
    });
}

/** One document, read-only. */
export function useAppDocument({ appId, nodeId, draft, enabled }: Scope, ref: DocumentRef | null) {
    return useQuery<AppDocumentView, Error>({
        queryKey: ['studio-app-documents', 'view', appId, nodeId, draft, ref?.documentId ?? null, ref?.versionId ?? null],
        enabled: enabled && !!appId && !!ref,
        queryFn: () => {
            const r = ref as DocumentRef;
            return json<AppDocumentView>(`${base(appId as string)}/${encodeURIComponent(r.documentId)}?${qs({ node: nodeId, draft: draft && '1', version: r.versionId })}`);
        },
        staleTime: 30_000,
        retry: false,
    });
}

/** A document's revisions (newest first); `supported: false` for a spreadsheet. */
export function useAppDocumentVersions({ appId, nodeId, draft, enabled }: Scope, documentId: string | null) {
    return useQuery<{ supported: boolean; versions: AppDocumentVersion[] }, Error>({
        queryKey: ['studio-app-documents', 'versions', appId, nodeId, draft, documentId],
        enabled: enabled && !!appId && !!documentId,
        queryFn: () => json(`${base(appId as string)}/${encodeURIComponent(documentId as string)}/versions?${qs({ node: nodeId, draft: draft && '1' })}`),
        staleTime: 30_000,
        retry: false,
    });
}

/** What changed between two documents (or two revisions of one). */
export function useAppDocumentCompare({ appId, nodeId, draft, enabled }: Scope, left: DocumentRef | null, right: DocumentRef | null) {
    return useQuery<AppDocumentCompare, Error>({
        queryKey: ['studio-app-documents', 'compare', appId, nodeId, draft, left?.documentId ?? null, left?.versionId ?? null, right?.documentId ?? null, right?.versionId ?? null],
        enabled: enabled && !!appId && !!left && !!right,
        queryFn: () => json<AppDocumentCompare>(`${base(appId as string)}/compare?${qs({ draft: draft && '1' })}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node: nodeId, left, right }),
        }),
        staleTime: 30_000,
        retry: false,
    });
}
