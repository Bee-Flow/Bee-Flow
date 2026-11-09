/**
 * cloudFolderEvents.mts: a hint that something changed in a person's cloud storage, turned into
 * "check this person's cloud folders now".
 *
 * An "on change" folder source is polled every few minutes (core/kb/sources/cloudFolder.mts). Two
 * storages also push: the Nextcloud connector forwards file events (with the path of the file), and a
 * Microsoft Graph drive notification says "this drive changed" (without one). Both only ARM the
 * sources, exactly like the "Refresh now" button does (`requestRefresh`: next_refresh_at = now); the
 * 60-second tick runs the pass under its lock, its concurrency limit and its time budget. The hint
 * carries no content and decides nothing: the pass compares the storage's change markers itself.
 *
 * Only sources set to "on change" are armed, and only those the person created: a manual source said
 * "I will press the button", a scheduled one "nightly is fine". Never throws; a hint that fails is
 * caught by the next poll.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

interface CloudFolderRow {
    id: string;
    refreshMode: string;
    config: { path?: string | null; provider?: string };
}

export interface CloudFileEvent {
    provider: 'nextcloud_files' | 'onedrive' | 'google_drive';
    userId: string;
    /** Nextcloud: the path of the file, relative to the actor's files root. Other storages name none. */
    path?: string | null;
    /** A rename also names the path it had. */
    oldPath?: string | null;
}

export interface CloudEventDeps {
    listCloudFoldersByUser: (userId: string, provider: string) => Promise<CloudFolderRow[]>;
    requestRefresh: (id: string) => Promise<unknown>;
    warn: (msg: string) => void;
}

function defaultDeps(): CloudEventDeps {
    const store = nodeRequire('../../../stores/kbSources.js');
    const log = nodeRequire('../../../telemetry/log.js');
    return {
        listCloudFoldersByUser: (userId, provider) => store.listCloudFoldersByUser(userId, provider),
        requestRefresh: (id) => store.requestRefresh(id),
        warn: (msg) => log.warn(msg),
    };
}

/** `Docs/a.pdf`, `/Docs/a.pdf/` and `//Docs//a.pdf` are one path. */
export function normalizePath(path: string | null | undefined): string {
    const clean = `/${String(path || '')}`.replace(/\/+/g, '/').replace(/\/+$/, '');
    return clean || '/';
}

/** Is `folder` the path itself, or a folder above it? A prefix only counts at a segment boundary. */
export function isPrefixOf(folder: string | null | undefined, path: string | null | undefined): boolean {
    const f = normalizePath(folder);
    const p = normalizePath(path);
    return f === '/' || p === f || p.startsWith(`${f}/`);
}

/**
 * Arm the person's "on change" cloud folders the event can be about.
 * @returns how many sources were armed
 */
export async function onCloudFileEvent(event: CloudFileEvent, deps?: Partial<CloudEventDeps>): Promise<{ requested: number }> {
    const out = { requested: 0 };
    if (!event || !event.userId || !event.provider) return out;
    let d: CloudEventDeps;
    try {
        d = { ...defaultDeps(), ...(deps || {}) };
    } catch {
        return out;
    }
    try {
        const sources = await d.listCloudFoldersByUser(String(event.userId), event.provider);
        const paths = [event.path, event.oldPath].filter((p): p is string => typeof p === 'string' && p.length > 0);
        for (const source of sources || []) {
            if (source.refreshMode !== 'on_change') continue;
            // A storage that names the file (Nextcloud) arms only the folders that hold it; one that does
            // not (a OneDrive drive notification) arms every on-change folder of that account.
            if (event.provider === 'nextcloud_files') {
                if (paths.length === 0 || !paths.some((p) => isPrefixOf(source.config && source.config.path, p))) continue;
            }
            try {
                await d.requestRefresh(source.id);
                out.requested += 1;
            } catch (e) {
                d.warn(`[KBCloudFolder] could not arm source ${source.id}: ${(e as Error).message}`);
            }
        }
    } catch (e) {
        d.warn(`[KBCloudFolder] cloud file event not handled: ${(e as Error).message}`);
    }
    return out;
}

/**
 * Fire-and-forget for a webhook route: arm behind the acknowledgement, on the next turn of the event
 * loop, and never let anything escape (an exception inside a setImmediate callback would be uncaught).
 */
export function scheduleCloudFileEvent(event: CloudFileEvent, deps?: Partial<CloudEventDeps>): void {
    setImmediate(() => {
        onCloudFileEvent(event, deps).catch((e: unknown) => {
            try { nodeRequire('../../../telemetry/log.js').warn(`[KBCloudFolder] cloud file event failed: ${(e as Error).message}`); } catch { /* nothing left to tell */ }
        });
    });
}
