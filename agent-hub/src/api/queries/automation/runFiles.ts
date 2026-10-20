// The files a run kept (generate_document, fill_document, presentation): the
// handle a step's output carries, and the three read routes behind it
// (server/routes/automation/runFiles.js). The bytes need the session, so they
// are fetched with it and handed to the browser as a blob, never linked.

import { API_BASE, authFetch } from '../../../utils/helpers';
import { failure } from './http';

/** One kept file, as a step's output describes it. */
export interface RunFileRef {
    fileId: string;
    name: string;
    mime: string;
    size: number | null;
}

export type RunFilePreviewKind = 'pdf' | 'image';

const MAX_DEPTH = 3;
const MAX_NODES = 200;
const MAX_FILES = 20;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const baseType = (mime: string) => mime.split(';')[0].trim().toLowerCase();

/** How a file can be shown without leaving the page: a PDF page by page, a raster image whole. SVG is never inlined. */
export function previewKindOf(mime: string): RunFilePreviewKind | null {
    const type = baseType(mime);
    if (type === 'application/pdf') return 'pdf';
    return /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(type) ? 'image' : null;
}

function refOf(node: Record<string, unknown>): RunFileRef | null {
    const handle = isRecord(node.sourceHandle) ? node.sourceHandle : node;
    if (handle.kind !== 'generated_file') return null;
    const fileId = text(handle.fileId);
    // A dry run keeps nothing: its handle is a placeholder.
    if (!fileId || fileId === 'dry-run') return null;
    return {
        fileId,
        name: text(node.filename) ?? text(node.name) ?? 'file',
        mime: text(node.mimeType) ?? text(node.mime) ?? 'application/octet-stream',
        size: typeof node.size === 'number' && Number.isFinite(node.size) ? node.size : null,
    };
}

/**
 * The kept files a step's output points at: `{ filename, mimeType, size,
 * sourceHandle: { kind: 'generated_file', fileId } }` at the top, or in a
 * record or list inside it (a loop collects one per round).
 */
export function generatedFilesOf(output: unknown): RunFileRef[] {
    const found = new Map<string, RunFileRef>();
    let nodes = 0;
    const walk = (value: unknown, depth: number) => {
        if (found.size >= MAX_FILES || nodes++ >= MAX_NODES) return;
        if (Array.isArray(value)) {
            if (depth < MAX_DEPTH) value.forEach((v) => walk(v, depth + 1));
            return;
        }
        if (!isRecord(value)) return;
        const ref = refOf(value);
        if (ref) {
            if (!found.has(ref.fileId)) found.set(ref.fileId, ref);
            return;
        }
        if (depth < MAX_DEPTH) Object.values(value).forEach((v) => walk(v, depth + 1));
    };
    walk(output, 0);
    return [...found.values()];
}

const fileUrl = (runId: string, fileId: string, tail = '') =>
    `${API_BASE}/api/automation/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(fileId)}${tail}`;

/** The route a file's bytes come from. */
export const runFileDownloadUrl = (runId: string, fileId: string) => fileUrl(runId, fileId);

async function getBlob(url: string, what: string): Promise<{ blob: Blob; res: Response }> {
    const res = await authFetch(url);
    if (!res.ok) throw await failure(res, `${what} ${res.status}`);
    return { blob: await res.blob(), res };
}

/** Save a kept file through the browser's download. */
export async function downloadRunFile(runId: string, fileId: string, name: string): Promise<void> {
    const { blob } = await getBlob(fileUrl(runId, fileId), 'Download');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    // Chrome needs the object URL to outlive the click.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A raster image, to show in the page (the route serves it inline only for those). */
export async function fetchRunFileImage(runId: string, fileId: string): Promise<Blob> {
    return (await getBlob(fileUrl(runId, fileId, '?inline=1'), 'Preview')).blob;
}

/**
 * One page of a PDF as a PNG, with the number of pages the pager may offer:
 * the page count the server reports, held to the server's preview cap
 * (`X-Preview-Max-Pages`, absent when there is none) so it never offers a page
 * the server refuses.
 */
export async function fetchRunFilePage(runId: string, fileId: string, page: number): Promise<{ blob: Blob; totalPages: number | null }> {
    const { blob, res } = await getBlob(fileUrl(runId, fileId, `/preview?page=${page}`), 'Preview');
    const total = Number(res.headers?.get('X-Preview-Total-Pages'));
    const max = Number(res.headers?.get('X-Preview-Max-Pages'));
    if (!(Number.isFinite(total) && total > 0)) return { blob, totalPages: null };
    return { blob, totalPages: Number.isFinite(max) && max > 0 ? Math.min(total, max) : total };
}
