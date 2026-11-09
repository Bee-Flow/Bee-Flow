/**
 * cloudFolderWalk.mts: the walk of a cloud folder for the knowledge source (./cloudFolder.mts).
 *
 * Breadth first, through the provider layer's `list` (documents mode), one level at a time. A failure
 * listing the chosen folder fails the pass; a failure below it, a tree deeper than MAX_DEPTH or more
 * files than the cap only mark the listing `partial`, so what was not listed is never taken for gone.
 * A file is keyed by the storage's own file id: without one it cannot keep its document across a
 * rename, and the path is not an identity.
 */

export type CloudProvider = 'nextcloud_files' | 'onedrive' | 'google_drive';

export interface CloudConfig {
    provider?: CloudProvider;
    folderId?: string | null;
    driveId?: string | null;
    path?: string | null;
    recursive?: boolean;
    syncCursor?: string | null;
    ncInstanceId?: string | null;
}

export type Marker = Record<string, unknown>;

/** A file the listing offers, as the engine sees it. */
export interface CloudItem {
    externalId: string;
    provider: CloudProvider;
    fileId: string;
    driveId: string | null;
    path: string | null;
    name: string;
    mimeType: string | null;
    format: string;
    size: number | null;
    modifiedAt: string | null;
    webUrl: string | null;
    marker: Marker | null;
}

export interface FileRef {
    provider?: string;
    fileId?: string | null;
    driveId?: string | null;
    path?: string | null;
    name?: string | null;
    mimeType?: string | null;
    format?: string | null;
    size?: number | null;
    modifiedAt?: string | null;
    webUrl?: string | null;
    isFolder?: boolean;
    marker?: Marker | null;
}

export interface FileApi {
    list: (opts: { view: string; parentId?: unknown; path?: string; pageToken?: string | null }) => Promise<{ items?: FileRef[]; nextPageToken?: string | null }>;
    download: (file: FileRef, opts?: { maxBytes?: number | null }) => Promise<{ buffer: Buffer; marker?: Marker }>;
    changeCursor?: (folder: { folderId?: string | null; driveId?: string | null; path?: string | null }, cursor?: string | null) => Promise<{ changed: boolean; cursor: string | null }>;
}

/** How many folder levels below the chosen folder are walked. */
export const MAX_DEPTH = 10;

interface Level {
    /** How the provider is asked for the children of this folder. */
    parent: { parentId?: unknown; path?: string };
    depth: number;
    trail: string;
}

function rootLevel(cfg: CloudConfig): Level {
    if (cfg.provider === 'nextcloud_files') return { parent: { path: cfg.path || '/' }, depth: 0, trail: '' };
    const parentId = cfg.folderId ? (cfg.driveId && cfg.provider === 'onedrive' ? { id: cfg.folderId, driveId: cfg.driveId } : cfg.folderId) : null;
    return { parent: { parentId }, depth: 0, trail: '' };
}

function childLevel(cfg: CloudConfig, ref: FileRef, from: Level): Level {
    const trail = `${from.trail}/${ref.name || ''}`;
    if (cfg.provider === 'nextcloud_files') return { parent: { path: ref.path || trail }, depth: from.depth + 1, trail };
    if (cfg.provider === 'onedrive') {
        return { parent: { parentId: ref.driveId ? { id: ref.fileId, driveId: ref.driveId } : ref.fileId }, depth: from.depth + 1, trail };
    }
    return { parent: { parentId: ref.fileId }, depth: from.depth + 1, trail };
}

function itemOf(provider: CloudProvider, ref: FileRef, trail: string): CloudItem | null {
    const fileId = ref.fileId != null ? String(ref.fileId) : '';
    // Without the storage's own id a file cannot keep its document across a rename, and the path is not an identity.
    if (!fileId || !ref.format) return null;
    const name = String(ref.name || '');
    return {
        externalId: fileId,
        provider,
        fileId,
        driveId: ref.driveId || null,
        path: ref.path || (name ? `${trail}/${name}` : null),
        name,
        mimeType: ref.mimeType || null,
        format: ref.format,
        size: ref.size != null ? Number(ref.size) : null,
        modifiedAt: ref.modifiedAt || null,
        webUrl: ref.webUrl || null,
        marker: ref.marker && typeof ref.marker === 'object' ? ref.marker : null,
    };
}

/**
 * The files of the folder (and, when `recursive`, of the folders below it). Marks `state.partial` when
 * the listing stopped short for any reason.
 */
export async function walkFolder(api: FileApi, cfg: CloudConfig, cap: number, state: { partial?: boolean; log: (...a: unknown[]) => void }, wrapError: (e: unknown) => Error): Promise<CloudItem[]> {
    const provider = cfg.provider as CloudProvider;
    const recursive = cfg.recursive !== false;
    const out = new Map<string, CloudItem>();
    const queue: Level[] = [rootLevel(cfg)];
    const visited = new Set<string>();

    while (queue.length > 0) {
        const level = queue.shift() as Level;
        const key = JSON.stringify(level.parent);
        if (visited.has(key)) continue;
        visited.add(key);
        let pageToken: string | null = null;
        do {
            let page: Awaited<ReturnType<FileApi['list']>>;
            try {
                page = await api.list({ view: 'mine', ...level.parent, pageToken });
            } catch (e) {
                if (level.depth === 0) throw wrapError(e);
                state.partial = true;
                state.log(`cloud folder: a sub-folder could not be listed (${(e as Error).message}); nothing is removed this pass`);
                break;
            }
            for (const ref of page.items || []) {
                if (ref.isFolder) {
                    if (!recursive) continue;
                    if (level.depth + 1 > MAX_DEPTH) { state.partial = true; continue; }
                    queue.push(childLevel(cfg, ref, level));
                    continue;
                }
                const item = itemOf(provider, ref, level.trail);
                if (!item || out.has(item.externalId)) continue;
                if (out.size >= cap) { state.partial = true; break; }
                out.set(item.externalId, item);
            }
            pageToken = out.size >= cap ? null : (page.nextPageToken || null);
        } while (pageToken);
        if (out.size >= cap && queue.length > 0) {
            state.partial = true;
            state.log(`cloud folder: the folder has more than ${cap} files; the rest is not read (KB_CLOUD_MAX_FILES)`);
            break;
        }
    }
    return [...out.values()];
}
