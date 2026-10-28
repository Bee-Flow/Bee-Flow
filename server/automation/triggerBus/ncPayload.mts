/**
 * One canonical payload per Nextcloud trigger event, whichever producer saw it.
 *
 * Two producers deliver the same `file.*` event: the connector's webhook
 * (routes/automation/events.js, built in nextcloud-connector's
 * automationEventsWebhook.js) and the activity-feed poller
 * (pollers/nextcloud.js). Each knows different things: the webhook has `id`,
 * `owner` and `actorName` but no `activityId`; the poller has `activityId`
 * and a link but no display name. Left to themselves they emit different
 * shapes, and a binding that resolves for one producer comes back empty for
 * the other.
 *
 * Every Nextcloud payload now passes through `normaliseNextcloudPayload`
 * before a subscription's filter sees it (triggerBus/dispatch.js, both fan-out
 * paths), and the poller builds its rows with `normaliseFilePayload` too. The
 * catalog's field list for the file events IS `FILE_FIELDS`, so the declared
 * fields, the filters and the builder's field list cannot drift apart.
 *
 * Backwards compatible by construction: the canonical keys are added, never
 * renamed, and every key a producer already sent (`objectName`, `type`,
 * `subject`, `oldPath`, `sourceId`, `raw`, ...) passes through untouched. A
 * key the producer did not know is present and `null`, never missing.
 */

type Payload = Record<string, unknown>;

/** The keys every `file.*` payload carries, in catalog order. */
export const FILE_FIELDS = Object.freeze([
    'id', 'activityId', 'path', 'name', 'extension', 'kind',
    'actor', 'actorName', 'owner', 'datetime', 'link', 'isOwnAction',
] as const);

/** Nextcloud file events a payload of the file shape belongs to. */
export const FILE_EVENT_IDS: ReadonlySet<string> = new Set([
    'file.new', 'file.changed', 'file.deleted', 'file.renamed', 'file.copied', 'file.restored',
]);

function str(v: unknown): string | null {
    return typeof v === 'string' && v !== '' ? v : null;
}

function idOrNull(v: unknown): string | number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') return v;
    return null;
}

/** `name` and lower-case `extension` (no dot) of a path; both null for no path. */
export function fileNameParts(path: string | null): { name: string | null, extension: string | null } {
    if (!path) return { name: null, extension: null };
    const name = path.split('/').filter(Boolean).pop() || null;
    const dot = name ? name.lastIndexOf('.') : -1;
    // A leading dot (".env") is a hidden name, not an extension.
    const extension = name && dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
    return { name, extension };
}

/**
 * File or folder. Neither producer knows for sure: the activity feed says
 * `files` for both, and the webhook envelope carries only id and path. Both
 * use the same rule, so the answer never depends on which one saw the
 * event: a trailing slash or a name without an extension reads as a folder.
 */
export function guessKind(path: string | null, extension: string | null): 'file' | 'folder' {
    if (!path) return 'file';
    return path.endsWith('/') || !extension ? 'folder' : 'file';
}

/**
 * The canonical `file.*` payload. `viewerUid` is the Nextcloud user whose
 * Files tree `path` is relative to, when the producer knows it and the raw
 * payload does not say (the poller reads one user's own activity feed).
 */
export function normaliseFilePayload(raw: Payload | null | undefined, opts: { viewerUid?: string | null } = {}): Payload {
    const src: Payload = raw && typeof raw === 'object' ? raw : {};
    const path = str(src.path) ?? str(src.objectName);
    const parts = fileNameParts(path);
    const name = str(src.name) ?? parts.name;
    const extension = str(src.extension)?.toLowerCase() ?? parts.extension;
    return {
        ...src,
        id: idOrNull(src.id) ?? idOrNull(src.objectId) ?? idOrNull(src.fileId),
        activityId: idOrNull(src.activityId),
        path,
        name,
        extension,
        kind: guessKind(path, extension),
        actor: str(src.actor),
        actorName: str(src.actorName),
        owner: str(src.owner) ?? str(opts.viewerUid),
        datetime: str(src.datetime),
        link: str(src.link),
        isOwnAction: src.isOwnAction === true,
    };
}

/**
 * Calendar payloads: the webhook sends the numeric calendar id plus the URI,
 * the upcoming-poller only the URI (as `calendarId`). Both keys are always
 * present; a filter on either form matches either producer.
 */
export function normaliseCalendarPayload(raw: Payload | null | undefined): Payload {
    const src: Payload = raw && typeof raw === 'object' ? raw : {};
    const id = idOrNull(src.calendarId);
    const uri = str(src.calendarUri) ?? (typeof id === 'string' && !/^\d+$/.test(id) ? id : null);
    return { ...src, calendarId: id ?? uri, calendarUri: uri };
}

/** Canonical payload for any Nextcloud trigger event (unknown events pass through). */
export function normaliseNextcloudPayload(event: string, raw: Payload | null | undefined, opts: { viewerUid?: string | null } = {}): Payload {
    if (FILE_EVENT_IDS.has(event)) return normaliseFilePayload(raw, opts);
    if (event.startsWith('calendar.event.')) return normaliseCalendarPayload(raw);
    return raw && typeof raw === 'object' ? raw : {};
}
