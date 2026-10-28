/**
 * May this subscriber see this Nextcloud event? (#191)
 *
 * A Nextcloud push event (connector webhook or Talk bot) names the ACTOR who
 * caused it. Until now it reached only the actor's own automations. To let a
 * colleague's automation react ("Bob posted in our room", "someone moved a card
 * on our board") the dispatcher fans out across the organisation, and every
 * delivery to someone other than the actor is decided HERE, per event and per
 * subscriber, by asking Nextcloud as that subscriber. An automation never sees
 * an event, a message or a file name its owner cannot see in Nextcloud itself.
 *
 *   talk.message.received, talk.reaction.added
 *       the subscriber is an attendee of the room (participantType owner,
 *       moderator, user or self-joined user; a non-member of a public room
 *       reads back as a guest and is refused).
 *   deck.card.*
 *       the subscriber can open the board.
 *   tables.row.*
 *       the subscriber may read the table's rows (READ on the table itself;
 *       access through a view only, or create-only access, is refused).
 *   forms.submitted
 *       the subscriber owns the form or holds the `results` permission (a
 *       person who may only fill the form in is refused).
 *   file.new, file.changed, file.renamed, file.deleted
 *       the path is in the subscriber's own Files tree (`owner`), or the file
 *       id resolves in it (WebDAV SEARCH on oc:fileid as the subscriber). The
 *       subscriber then receives the path as THEY see it, never the actor's.
 *       `file.deleted` carries no id, so only the owner match applies.
 *
 * Everything else stays with the actor: calendar events (the payload names
 * the calendar by its owner-relative URI and numeric id, not by owner, so the
 * subscriber's access cannot be established), file.tagged / file.untagged
 * (the tag itself may be invisible to the subscriber) and any event not
 * listed above.
 *
 * Every check asks as the subscriber with the credentials the server already
 * holds for them (connector impersonation, OAuth or their app password), runs
 * through the org's Nextcloud scope guard first, and fails closed: no
 * credentials, an error, a timeout or an unexpected answer all read as "not
 * visible". Results are memoised per dispatch only, so a membership removed a
 * moment ago is honoured on the very next event.
 *
 * A leaf: the server's modules arrive through `deps` (built in triggerBus.js).
 */

type Payload = Record<string, unknown>;
type ToolResult = Record<string, unknown> | null | undefined;

export interface NcAuthLike {
    baseUrl: string;
    uid?: string;
    fetch: (url: string, options?: Record<string, unknown>) => Promise<{ ok: boolean, status: number, text: () => Promise<string>, json?: () => Promise<unknown> }>;
}

export interface NcVisibilityDeps {
    /** Credentials for a Bee Flow user, as the polling pass builds them; null when there are none. */
    loadSession: (userId: string) => Promise<unknown | null>;
    resolveAuth: (session: unknown, userId: string) => Promise<NcAuthLike>;
    /** Run a nextcloud_* tool as the user. */
    runTool: (toolName: string, args: Record<string, unknown>, userId: string, session: unknown) => Promise<ToolResult>;
    /** True when the org's Nextcloud scope refuses this call for the user. */
    scopeDenied: (toolName: string, args: Record<string, unknown>, userId: string, session: unknown) => Promise<boolean>;
    log?: { warn: (...a: unknown[]) => void };
}

export type VisibilityKind = 'talk_room' | 'deck_board' | 'table_rows' | 'form_results' | 'file';

/** The event types a colleague's automation may receive, and how each is checked. */
export const EVENT_VISIBILITY: Readonly<Record<string, VisibilityKind>> = Object.freeze({
    'talk.message.received': 'talk_room',
    'talk.reaction.added': 'talk_room',
    'deck.card.created': 'deck_board',
    'deck.card.changed': 'deck_board',
    'deck.card.deleted': 'deck_board',
    'deck.card.completed': 'deck_board',
    'deck.card.moved': 'deck_board',
    'tables.row.added': 'table_rows',
    'tables.row.updated': 'table_rows',
    'tables.row.deleted': 'table_rows',
    'forms.submitted': 'form_results',
    'file.new': 'file',
    'file.changed': 'file',
    'file.renamed': 'file',
    'file.deleted': 'file',
});

/**
 * The events whose trigger offers the "also colleagues' events" switch
 * (filter.includeColleagues). file.new and file.changed are checked like the
 * other file events but get no switch: they are read off the subscriber's own
 * activity feed (pollers/nextcloud.js), which already lists colleagues' changes
 * to files the subscriber can see — and always has.
 */
export const COLLEAGUE_SWITCH_EVENTS: ReadonlySet<string> = new Set(
    Object.keys(EVENT_VISIBILITY).filter(e => e !== 'file.new' && e !== 'file.changed'),
);

/** A catalog event marked `colleagues: true` when it offers that switch (the builder shows it only there). */
export function withColleagues<E extends { id: string }>(event: E): E | (E & { colleagues: true }) {
    return COLLEAGUE_SWITCH_EVENTS.has(event.id) ? { ...event, colleagues: true as const } : event;
}

export function visibilityKind(event: string): VisibilityKind | null {
    return Object.hasOwn(EVENT_VISIBILITY, event) ? EVENT_VISIBILITY[event] : null;
}

export interface Decision {
    visible: boolean;
    /** Payload keys to replace for this subscriber (a file path in their own view). */
    overrides?: Payload;
}

/** Per-dispatch memo: one dispatch, one answer per (subscriber, resource). */
export type VisibilityMemo = Map<string, Promise<unknown>>;

const NOT_VISIBLE: Decision = Object.freeze({ visible: false });
/** Talk participant types that are real attendees: owner, moderator, user, self-joined user. */
const TALK_MEMBER_TYPES = new Set([1, 2, 3, 5]);
const FORMS_API = '/ocs/v2.php/apps/forms/api/v3';
const OCS_HEADERS = { 'OCS-APIRequest': 'true', 'Accept': 'application/json' };

function idOf(v: unknown): string | null {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    return null;
}

function hasError(r: ToolResult): boolean {
    return !r || typeof r !== 'object' || r.error !== undefined;
}

function memoised<T>(memo: VisibilityMemo, key: string, run: () => Promise<T>): Promise<T> {
    const hit = memo.get(key);
    if (hit) return hit as Promise<T>;
    const p = run();
    memo.set(key, p);
    return p;
}

function xmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** WebDAV SEARCH body: the node with this file id anywhere in the user's Files tree. */
export function fileIdSearchBody(uid: string, fileId: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop><oc:fileid/></d:prop></d:select>
    <d:from><d:scope><d:href>/files/${xmlEscape(uid)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where><d:eq><d:prop><oc:fileid/></d:prop><d:literal>${xmlEscape(fileId)}</d:literal></d:eq></d:where>
    <d:limit><d:nresults>1</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;
}

/** The user-relative path of the first SEARCH hit in `uid`'s Files tree, or null. */
export function pathFromSearch(xml: string, uid: string): string | null {
    const prefix = `/remote.php/dav/files/${uid}`;
    for (const m of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?href>([^<]*)<\/(?:[A-Za-z0-9_-]+:)?href>/g)) {
        let href = m[1].trim();
        try { href = decodeURIComponent(href); } catch { continue; }
        const at = href.indexOf(prefix);
        if (at < 0) continue;
        const rest = href.slice(at + prefix.length);
        if (rest !== '' && !rest.startsWith('/')) continue; // another user whose uid starts with ours
        const path = rest.replace(/\/+$/, '');
        if (path) return path;
    }
    return null;
}

function dirOf(path: string): string {
    const i = path.lastIndexOf('/');
    return i <= 0 ? '/' : path.slice(0, i);
}

function baseOf(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The subscriber-view payload keys for a file found at `path`. A rename's
 * `oldPath` is translated only when the file stayed in the same folder; after
 * a move the old folder is the actor's business, so it is dropped.
 */
function fileOverrides(payload: Payload, path: string, uid: string): Payload {
    const name = baseOf(path);
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
    const out: Payload = { path, name, extension, owner: uid };
    if (typeof payload.oldPath === 'string' && typeof payload.path === 'string') {
        out.oldPath = dirOf(payload.oldPath) === dirOf(payload.path) ? `${dirOf(path) === '/' ? '' : dirOf(path)}/${baseOf(payload.oldPath)}` : null;
    }
    if (typeof payload.objectName === 'string') out.objectName = path;
    return out;
}

export function createNcVisibility(deps: NcVisibilityDeps) {
    const warn = (msg: string) => { try { deps.log?.warn(msg); } catch { /* logging never decides */ } };

    async function sessionFor(userId: string, memo: VisibilityMemo): Promise<unknown | null> {
        return memoised(memo, `session|${userId}`, () => deps.loadSession(userId).catch(() => null));
    }

    async function authFor(userId: string, session: unknown, memo: VisibilityMemo): Promise<NcAuthLike | null> {
        return memoised(memo, `auth|${userId}`, () => deps.resolveAuth(session, userId).catch(() => null));
    }

    async function toolOk(name: string, args: Record<string, unknown>, userId: string, session: unknown): Promise<ToolResult> {
        if (await deps.scopeDenied(name, args, userId, session)) return null;
        return deps.runTool(name, args, userId, session);
    }

    async function talkRoom(userId: string, session: unknown, payload: Payload): Promise<Decision> {
        const token = idOf(payload.roomToken);
        if (!token) return NOT_VISIBLE;
        const room = await toolOk('nextcloud_talk_get_room', { token }, userId, session);
        if (hasError(room)) return NOT_VISIBLE;
        return { visible: TALK_MEMBER_TYPES.has(Number((room as Payload).participantType)) };
    }

    async function deckBoard(userId: string, session: unknown, payload: Payload): Promise<Decision> {
        const boardId = idOf(payload.boardId);
        if (!boardId) return NOT_VISIBLE;
        const board = await toolOk('nextcloud_deck_get_board', { boardId }, userId, session);
        return { visible: !hasError(board) };
    }

    async function tableRows(userId: string, session: unknown, payload: Payload): Promise<Decision> {
        const tableId = idOf(payload.tableId);
        if (!tableId || !/^\d+$/.test(tableId)) return NOT_VISIBLE;
        // Reading rows needs READ on the table itself — stricter than seeing
        // its columns, which create-only and view-only access also allow.
        const rows = await toolOk('nextcloud_tables_list_rows', { tableId: Number(tableId), limit: 1 }, userId, session);
        return { visible: !hasError(rows) };
    }

    async function formResults(userId: string, session: unknown, payload: Payload, memo: VisibilityMemo): Promise<Decision> {
        const formId = idOf(payload.formId);
        if (!formId || !/^\d+$/.test(formId)) return NOT_VISIBLE;
        if (await deps.scopeDenied('nextcloud_forms_get', { formId }, userId, session)) return NOT_VISIBLE;
        const auth = await authFor(userId, session, memo);
        if (!auth) return NOT_VISIBLE;
        const res = await auth.fetch(`${auth.baseUrl}${FORMS_API}/forms/${encodeURIComponent(formId)}`, { headers: OCS_HEADERS });
        if (!res.ok) return NOT_VISIBLE;
        let data: Payload | null = null;
        try {
            const body = JSON.parse(await res.text()) as { ocs?: { data?: Payload } };
            data = body?.ocs?.data ?? null;
        } catch { return NOT_VISIBLE; }
        if (!data) return NOT_VISIBLE;
        const perms = Array.isArray(data.permissions) ? data.permissions : [];
        return { visible: perms.includes('results') || (typeof data.ownerId === 'string' && data.ownerId === auth.uid) };
    }

    async function file(userId: string, session: unknown, payload: Payload, memo: VisibilityMemo): Promise<Decision> {
        const auth = await authFor(userId, session, memo);
        if (!auth?.uid) return NOT_VISIBLE;
        // The path is relative to `owner`'s Files tree: for that user it is
        // already their own view.
        if (typeof payload.owner === 'string' && payload.owner === auth.uid) return { visible: true };
        const fileId = idOf(payload.id);
        if (!fileId || !/^\d+$/.test(fileId)) return NOT_VISIBLE;
        const res = await auth.fetch(`${auth.baseUrl}/remote.php/dav/`, {
            method: 'SEARCH',
            headers: { 'Content-Type': 'text/xml; charset=utf-8' },
            body: fileIdSearchBody(auth.uid, fileId),
        });
        if (!res.ok) return NOT_VISIBLE;
        const path = pathFromSearch(await res.text(), auth.uid);
        if (!path) return NOT_VISIBLE;
        if (await deps.scopeDenied('nextcloud_read_file', { path }, userId, session)) return NOT_VISIBLE;
        return { visible: true, overrides: fileOverrides(payload, path, auth.uid) };
    }

    /**
     * Decide one delivery. `userId` is the SUBSCRIBER (the automation owner),
     * never the actor: the actor's own deliveries do not come through here.
     */
    async function check(userId: string, event: string, payload: Payload, memo: VisibilityMemo): Promise<Decision> {
        const kind = visibilityKind(event);
        if (!kind || !userId) return NOT_VISIBLE;
        const resource = kind === 'talk_room' ? idOf(payload.roomToken)
            : kind === 'deck_board' ? idOf(payload.boardId)
                : kind === 'table_rows' ? idOf(payload.tableId)
                    : kind === 'form_results' ? idOf(payload.formId)
                        : `${idOf(payload.id) ?? ''}|${typeof payload.owner === 'string' ? payload.owner : ''}|${typeof payload.path === 'string' ? payload.path : ''}`;
        return memoised(memo, `vis|${userId}|${kind}|${resource ?? ''}`, async () => {
            try {
                const session = await sessionFor(userId, memo);
                if (!session) return NOT_VISIBLE;
                switch (kind) {
                    case 'talk_room': return await talkRoom(userId, session, payload);
                    case 'deck_board': return await deckBoard(userId, session, payload);
                    case 'table_rows': return await tableRows(userId, session, payload);
                    case 'form_results': return await formResults(userId, session, payload, memo);
                    case 'file': return await file(userId, session, payload, memo);
                    default: return NOT_VISIBLE;
                }
            } catch (e) {
                // Ids only: a file name or room name is user data.
                warn(`[TriggerBus] nextcloud visibility check (${kind}) failed for user ${userId}: ${e instanceof Error ? e.message : String(e)}`);
                return NOT_VISIBLE;
            }
        });
    }

    /**
     * The names of `tagIds` as the subscriber sees the tag list (an invisible
     * tag has no name for them, so a name filter cannot match it).
     */
    async function tagNames(userId: string, tagIds: unknown, memo: VisibilityMemo): Promise<string[]> {
        const ids = (Array.isArray(tagIds) ? tagIds : []).map(idOf).filter((v): v is string => !!v);
        if (!ids.length || !userId) return [];
        const byId = await memoised(memo, `tags|${userId}`, async () => {
            const map = new Map<string, string>();
            try {
                const session = await sessionFor(userId, memo);
                if (!session) return map;
                const out = await toolOk('nextcloud_list_tags', {}, userId, session);
                const tags = !hasError(out) && Array.isArray((out as Payload).tags) ? (out as { tags: unknown[] }).tags : [];
                for (const t of tags) {
                    const tag = t as Payload;
                    const id = idOf(tag?.id);
                    if (id && typeof tag.name === 'string') map.set(id, tag.name);
                }
            } catch (e) {
                warn(`[TriggerBus] nextcloud tag lookup failed for user ${userId}: ${e instanceof Error ? e.message : String(e)}`);
            }
            return map;
        });
        return ids.map(id => byId.get(id)).filter((n): n is string => typeof n === 'string');
    }

    return { check, tagNames };
}

export type NcVisibility = ReturnType<typeof createNcVisibility>;
