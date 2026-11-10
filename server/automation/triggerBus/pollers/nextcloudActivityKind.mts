/**
 * What kind of event a row of the Nextcloud activity feed is, for the activity
 * pollers (./nextcloud.js).
 *
 * A row is classified on its activity `type` and on the parameter names of its
 * rich subject (`file`, `oldfile`, `newfile`, `actor`, `user`, ...). Both are
 * the same in every language; the translated subject text is read only where a
 * row carries no rich parameters.
 *
 * One pair the feed does not tell apart: a share the user received and a share
 * that was withdrawn have the same type and the same parameters. For those rows
 * `confirmReceivedShares` asks which files are shared with the user right now.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../../telemetry/log.js') as { warn: (...a: unknown[]) => void };

/** One row of the Nextcloud activity feed, as integrations/nextcloudActivityTools maps it. */
export interface NcActivityRow {
    id?: number;
    type?: string;
    subject?: string;
    message?: string;
    actor?: string;
    objectName?: string;
    objectType?: string;
    objectId?: number | string;
    link?: string;
    datetime?: string;
    richKeys?: string[];
}

export type NcPollSession = {
    nextcloudUid?: string | null;
    connectorNcUid?: string | null;
    automationProviders?: { nextcloud?: { nextcloudUid?: string | null } };
} | null | undefined;

/** A normalised row on its way to a subscription: the payload plus the routing flags. */
export interface NcPolledPayload {
    raw?: NcActivityRow;
    _isShareReceived?: boolean;
    [key: string]: unknown;
}

export interface ShareConfirmCtx {
    nextcloudActivityTools: () => {
        incomingShareFileIds: (userId: string, session: NcPollSession) => Promise<Set<string> | null>;
    };
}

/**
 * Seconds between two warnings about a failing read for the same user.
 * Configurable; 0 = warn on every failed read. The default is 15 minutes.
 */
function activityWarnIntervalMs(): number {
    const raw = parseInt(String(process.env.AUTOMATION_NC_ACTIVITY_WARN_INTERVAL_SECONDS ?? ''), 10);
    return (Number.isFinite(raw) && raw >= 0 ? raw : 900) * 1000;
}

/** userId → time of the last warning */
const warnedAt = new Map<string, number>();

/**
 * Warn that a read for the activity triggers failed, at most once per interval
 * per user: the poller asks again on every tick.
 */
export function warnActivityRead(userId: string, what: string, reason: unknown): void {
    const every = activityWarnIntervalMs();
    const last = warnedAt.get(userId);
    const now = Date.now();
    if (every > 0 && last !== undefined && now - last < every) return;
    warnedAt.set(userId, now);
    log.warn(`[TriggerBus] nextcloud ${what} failed for user ${userId}: ${String(reason)}`);
}

// A file moved, renamed, copied or restored, in the subject text (EN + NL). Read
// only as the fallback for a row whose rich parameters do not say so.
const ARRIVAL_SUBJECT_RE = /\b(moved|renamed|copied|restored|verplaatst|hernoemd|gekopieerd|teruggezet)\b/;

function richKeysOf(row: NcActivityRow): string[] {
    return Array.isArray(row.richKeys) ? row.richKeys.map(String) : [];
}

/**
 * file.new = "a file APPEARED in the folder": a fresh upload (file_created), a
 * restore (file_restored), or a file moved / renamed INTO the folder. Nextcloud
 * has no move activity type: it reports a move or rename as `file_changed`
 * whose rich subject names an old and a new file (the destination path lands in
 * objectName, which the inFolder filter matches). A plain in-place edit names
 * one file and stays file.changed only.
 */
function isFileArrival(t: string, subj: string, keys: string[]): boolean {
    if (t === 'file_created' || t === 'file_restored') return true;
    if (t === 'files' && subj.includes('created')) return true;
    if (t !== 'file_changed' && t !== 'files') return false;
    return keys.some((k) => k.startsWith('newfile') || k.startsWith('oldfile')) || ARRIVAL_SUBJECT_RE.test(subj);
}

/**
 * A row of type `shared`. With rich parameters, only a row that names an actor
 * and a file and nobody else can be a share the user received ("{actor} shared
 * {file} with you"); a share the user made also names a user, group or address.
 * `inbound` alone does not make it `received` (a withdrawn share looks the
 * same): the English subject does, or `confirmReceivedShares`.
 */
function shareKind(t: string, subj: string, keys: string[], isOwnAction: boolean): { received: boolean; inbound: boolean } {
    if (t === 'shared_with_you' || t === 'remote_share_received') return { received: true, inbound: false };
    if (t !== 'shares' && t !== 'shared') return { received: false, inbound: false };
    const saysShared = subj.includes('shared');
    if (!keys.length) return { received: saysShared, inbound: false };
    const inbound = !isOwnAction && keys.includes('actor')
        && keys.every((k) => k === 'actor' || k.startsWith('file'));
    return { received: inbound && saysShared, inbound };
}

export function classifyActivity(row: NcActivityRow, session: NcPollSession) {
    const t = String(row.type || '').toLowerCase();
    const subj = String(row.subject || '').toLowerCase();
    const keys = richKeysOf(row);
    const sessionUid = session?.nextcloudUid
        || session?.automationProviders?.nextcloud?.nextcloudUid
        || session?.connectorNcUid
        || null;
    const isOwnAction = !!(sessionUid && row.actor === sessionUid);
    const share = shareKind(t, subj, keys, isOwnAction);
    return {
        sessionUid,
        isOwnAction,
        isFileCreated: isFileArrival(t, subj, keys),
        isFileChanged: t === 'file_changed' || t === 'file_updated' || (t === 'files' && (subj.includes('changed') || subj.includes('updated'))),
        isShareReceived: share.received,
        isShareInbound: share.inbound,
    };
}

/**
 * share.received, for the rows the subject text does not settle: they are
 * checked against the files that are shared with the user right now. Per file
 * only the newest row counts. One read per tick, and only when such a row is
 * new; when the read fails those rows stay unrecognised.
 *
 * @param payloads  the new rows of this tick, oldest first
 */
export async function confirmReceivedShares(
    ctx: ShareConfirmCtx, userId: string, session: NcPollSession, payloads: NcPolledPayload[],
): Promise<void> {
    /** file id → its newest row that can be either */
    const newest = new Map<string, NcPolledPayload>();
    for (const p of payloads) {
        if (!p.raw || p.raw.objectId == null) continue;
        if (classifyActivity(p.raw, session).isShareInbound) newest.set(String(p.raw.objectId), p);
    }
    const open = [...newest].filter(([, p]) => !p._isShareReceived);
    if (!open.length) return;
    let shared: Set<string> | null = null;
    try {
        shared = await ctx.nextcloudActivityTools().incomingShareFileIds(userId, session);
    } catch (e) {
        warnActivityRead(userId, 'incoming share list', (e as Error).message);
        return;
    }
    if (!shared) {
        warnActivityRead(userId, 'incoming share list', 'no answer');
        return;
    }
    for (const [fileId, p] of open) {
        if (shared.has(fileId)) p._isShareReceived = true;
    }
}
