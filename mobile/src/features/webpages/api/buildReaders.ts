/**
 * Contract readers for building a page: its sources (stores/webpage/sources.js
 * mapSourceRow), its versions (stores/webpage/versions.js getVersions, as
 * routes/webpages/versionListing.js decorates them), its file bodies (GET
 * /:id `files`) and the draft document (routes/webpages/draftDocument.js).
 */

import { field, pick, shapeOf } from '@/core/api/contract';

import type {
    DraftDocument,
    SourceType,
    VersionActor,
    VersionPage,
    WebpageFiles,
    WebpageSource,
    WebpageVersion,
} from '../model/buildTypes';

const SOURCE_TYPES: readonly SourceType[] = ['pdf', 'docx', 'xlsx', 'csv', 'text', 'url', 'file', 'gdrive', 'onedrive'];

const readSourceRow = shapeOf({
    id: field.str(''),
    type: field.oneOf(SOURCE_TYPES, 'file'),
    name: field.str(''),
    status: field.oneOf(['processing', 'ready', 'error'] as const, 'processing'),
    error: field.strOrNull,
    wordCount: field.num(0),
    storageKey: field.strOrNull,
    createdAt: field.strOrNull,
});

/** One source; a url source keeps its address in `metadata.url`. */
export function readSource(raw: unknown): WebpageSource {
    return { ...readSourceRow(raw), url: field.strOrNull(pick(pick(raw, 'metadata'), 'url')) };
}

export function readSources(raw: unknown): WebpageSource[] {
    const list = pick(raw, 'sources');
    if (!Array.isArray(list)) return [];
    return list.map(readSource).filter((s) => s.id !== '');
}

function readActor(raw: unknown): VersionActor | null {
    if (raw === null || typeof raw !== 'object') return null;
    return { name: field.strOrNull(pick(raw, 'name')), isYou: pick(raw, 'isYou') === true };
}

const readVersionRow = shapeOf({
    id: field.str(''),
    seq: field.numOrNull,
    summary: field.str(''),
    source: field.oneOf(['manual', 'ai', 'published', 'restore'] as const, 'manual'),
    contentLength: field.num(0),
    createdAt: field.strOrNull,
    lineDelta: field.numOrNull,
    isPublished: field.bool(false),
});

export function readVersion(raw: unknown): WebpageVersion {
    return { ...readVersionRow(raw), actor: readActor(pick(raw, 'actor')) };
}

/** GET /:id/versions. `coversProject` defaults to true: only a react-mui page says otherwise. */
export function readVersionPage(raw: unknown): VersionPage {
    const list = pick(raw, 'versions');
    const published = pick(raw, 'published');
    const versionId = field.strOrNull(pick(published, 'versionId'));
    return {
        versions: Array.isArray(list) ? list.map(readVersion).filter((v) => v.id !== '') : [],
        hasMore: pick(raw, 'hasMore') === true,
        published: versionId ? { versionId, seq: field.numOrNull(pick(published, 'seq')) } : null,
        coversProject: pick(pick(raw, 'coverage'), 'coversProject') !== false,
    };
}

/** The three bodies out of GET /:id (or the restore answer); a missing slot is empty. */
export function readFiles(raw: unknown): WebpageFiles {
    const files = pick(raw, 'files');
    return {
        html: field.str('')(pick(files, 'html')),
        css: field.str('')(pick(files, 'css')),
        js: field.str('')(pick(files, 'js')),
    };
}

const readDraftFields = shapeOf({
    status: field.oneOf(['ready', 'empty', 'stranded', 'build_error'] as const, 'build_error'),
    html: field.strOrNull,
    buildError: field.strOrNull,
    expiresAt: field.numOrNull,
});

/**
 * GET /:id/draft-document. A 'ready' answer without a document is not ready:
 * it reads as a build error, so the screen never frames an empty page as the
 * real one.
 */
export function readDraftDocument(raw: unknown): DraftDocument {
    const doc = readDraftFields(raw);
    if (doc.status === 'ready' && !doc.html) return { ...doc, status: 'build_error' };
    return doc;
}
