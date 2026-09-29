/**
 * Watched folders: a folder on disk that keeps a Bee Flow knowledge base up to
 * date.
 *
 * The point of doing this in the desktop client rather than on the server is
 * that the client is the only party that sees the file the moment it lands.
 * Someone drops a contract into `~/Nextcloud/Contracten`; Nextcloud syncs it up;
 * the knowledge base has it a second later, referenced by its WebDAV path so
 * the server reads the one copy rather than storing a second.
 *
 * Most of the work is deciding what NOT to react to. A sync folder is full of
 * files that are not documents: the client's own journal, the partial download
 * it is in the middle of, the placeholder standing in for a file that is not
 * downloaded at all, the lock file LibreOffice leaves behind. Ingesting any of
 * those produces a knowledge base full of noise and a support ticket.
 */

import type { NextcloudAccount, WatchedFileEvent, WatchedFolder } from '../../shared/types.ts';
import { resolveLocalPath } from './paths.ts';
import { basenameOf } from '../config/schema.ts';

/** The minimal chokidar surface used here, so tests need no filesystem. */
export interface WatcherLike {
    on(event: 'add' | 'change' | 'unlink', listener: (path: string) => void): unknown;
    on(event: 'error', listener: (error: unknown) => void): unknown;
    close(): Promise<void>;
}

export interface WatchOptions {
    depth?: number;
    ignoreInitial: boolean;
    awaitWriteFinish: { stabilityThreshold: number; pollInterval: number };
}

export type WatcherFactory = (path: string, options: WatchOptions) => WatcherLike;

/**
 * Names that are machinery, not documents.
 *
 * Each line is something seen in a real sync folder:
 *   - `._sync_*.db*` and `.owncloudsync.log*` are the Nextcloud client's journal;
 *   - `*.~<hex>` and `*.nextclouddownload` are partial downloads in flight;
 *   - `*.nextcloud` is a virtual-files placeholder: a zero-byte stand-in for a
 *     file that is not on this machine. Ingesting it would file an empty
 *     document under a real document's name;
 *   - `.~lock.*#` is LibreOffice, `~$*` is Office, `.goutputstream-*` is GTK's
 *     atomic save, `.DS_Store` and `Thumbs.db` are the platforms themselves;
 *   - anything starting with `.` is hidden, and a hidden file is not a document
 *     someone means to put in a knowledge base.
 */
const IGNORED_PATTERNS: RegExp[] = [
    /^\._sync_[0-9a-f]+\.db(-\w+)?$/i,
    /^\.owncloudsync\.log(\.\d+)?$/i,
    /^\.sync_[0-9a-f]+\.db(-\w+)?$/i,
    /\.nextclouddownload$/i,
    /\.owncloudsync$/i,
    /\.nextcloud$/i,
    /\.~[0-9a-f]{6,}$/i,
    /^\.~lock\..*#$/i,
    /^~\$/,
    /^\.goutputstream-/i,
    /^\.DS_Store$/i,
    /^Thumbs\.db$/i,
    /^desktop\.ini$/i,
    /\.(part|crdownload|tmp|swp|swx)$/i,
    /^\.#/,
];

/** Directories never worth descending into. */
const IGNORED_DIRECTORIES = ['.git', '.svn', 'node_modules', '.cache', '__pycache__', '.Trash', '.trashed'];

/** Should this path be left alone? Pure, and the part most worth testing. */
export function shouldIgnore(localPath: string): boolean {
    const posix = String(localPath ?? '').replace(/\\/g, '/');
    const segments = posix.split('/').filter(Boolean);
    const name = basenameOf(posix);
    if (!name) return true;

    for (const segment of segments.slice(0, -1)) {
        if (IGNORED_DIRECTORIES.includes(segment)) return true;
    }
    if (name.startsWith('.')) {
        // The dot-file rule covers most of the list above; the patterns stay
        // because plenty of the machinery does NOT start with a dot.
        return true;
    }
    return IGNORED_PATTERNS.some((pattern) => pattern.test(name));
}

export interface FolderWatcherOptions {
    createWatcher: WatcherFactory;
    /** Called for every file worth telling Bee Flow about. */
    onFile: (event: WatchedFileEvent) => void;
    onWarning?: (message: string) => void;
    /** Supplies the current accounts, so a re-read of the config is picked up. */
    accounts: () => readonly NextcloudAccount[];
    platform?: NodeJS.Platform;
    /** Coalescing window. A save is often several filesystem events. */
    debounceMs?: number;
    now?: () => number;
}

/** A save in an editor is an unlink, an add and two changes within milliseconds. */
export const DEFAULT_DEBOUNCE_MS = 750;

/** How long the file has to stop changing before it counts as written. */
export const WRITE_STABILITY_MS = 2_000;

export class FolderWatcher {
    private readonly options: FolderWatcherOptions;
    private readonly watchers = new Map<string, WatcherLike>();
    private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(options: FolderWatcherOptions) {
        this.options = options;
    }

    /** The folders currently being watched, by id. */
    get active(): string[] {
        return [...this.watchers.keys()];
    }

    /**
     * Make the running watchers match the settings.
     *
     * Called on every settings change, so it has to be idempotent: folders that
     * did not change keep their watcher (and therefore their state), new ones
     * start, removed and disabled ones stop.
     */
    async sync(folders: readonly WatchedFolder[]): Promise<void> {
        const wanted = new Map(folders.filter((folder) => folder.enabled).map((folder) => [folder.id, folder]));

        for (const id of [...this.watchers.keys()]) {
            if (!wanted.has(id)) await this.stop(id);
        }

        for (const [id, folder] of wanted) {
            if (this.watchers.has(id)) continue;
            this.start(id, folder);
        }
    }

    async stopAll(): Promise<void> {
        for (const id of [...this.watchers.keys()]) await this.stop(id);
        for (const timer of this.pending.values()) clearTimeout(timer);
        this.pending.clear();
    }

    private start(id: string, folder: WatchedFolder): void {
        let watcher: WatcherLike;
        try {
            watcher = this.options.createWatcher(folder.path, {
                ignoreInitial: true,
                // A folder that is being synced is being written to constantly;
                // waiting for the writes to stop is the difference between
                // ingesting a document and ingesting the first 4 KB of one.
                awaitWriteFinish: { stabilityThreshold: WRITE_STABILITY_MS, pollInterval: 200 },
                ...(folder.recursive ? {} : { depth: 0 }),
            });
        } catch (error) {
            this.options.onWarning?.(`could not watch ${folder.path}: ${describe(error)}`);
            return;
        }

        watcher.on('add', (path) => this.queue(folder, path, 'added'));
        watcher.on('change', (path) => this.queue(folder, path, 'changed'));
        watcher.on('unlink', (path) => this.queue(folder, path, 'removed'));
        watcher.on('error', (error) => {
            this.options.onWarning?.(`watching ${folder.path} failed: ${describe(error)}`);
        });

        this.watchers.set(id, watcher);
    }

    private async stop(id: string): Promise<void> {
        const watcher = this.watchers.get(id);
        this.watchers.delete(id);
        try {
            await watcher?.close();
        } catch (error) {
            this.options.onWarning?.(`could not stop a watcher: ${describe(error)}`);
        }
    }

    private queue(folder: WatchedFolder, localPath: string, kind: WatchedFileEvent['kind']): void {
        if (shouldIgnore(localPath)) return;

        const key = `${folder.id}:${localPath}`;
        const existing = this.pending.get(key);
        if (existing) clearTimeout(existing);

        this.pending.set(
            key,
            setTimeout(() => {
                this.pending.delete(key);
                this.emit(folder, localPath, kind);
            }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS),
        );
    }

    private emit(folder: WatchedFolder, localPath: string, kind: WatchedFileEvent['kind']): void {
        const reference = resolveLocalPath(localPath, this.options.accounts(), {
            platform: this.options.platform ?? process.platform,
            isDirectory: false,
        });

        const event: WatchedFileEvent = {
            folderId: folder.id,
            knowledgeBaseId: folder.knowledgeBaseId,
            localPath,
            kind,
            at: (this.options.now ?? Date.now)(),
        };
        // A watched folder does not have to be inside Nextcloud — watching
        // ~/Documents is a perfectly reasonable thing to want — so the remote
        // reference is added when there is one and left off when there is not.
        if (reference) {
            event.remote = {
                accountId: reference.accountId,
                serverUrl: reference.serverUrl,
                remotePath: reference.remotePath,
                webdavUrl: reference.webdavUrl,
            };
        }

        try {
            this.options.onFile(event);
        } catch (error) {
            this.options.onWarning?.(`a watched-file listener threw: ${describe(error)}`);
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
