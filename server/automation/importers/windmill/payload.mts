/**
 * The Windmill trigger payload (`flow_input.*`) to the Bee Flow trigger payload.
 *
 * A Nextcloud native trigger hands the flow `{ time, user: {uid, displayName},
 * event: {class, …}, authentication: {owner, trigger} }` (research 01 §3.3);
 * a Bee Flow nextcloud trigger hands `trigger.output` the flat, canonical
 * fields of triggerSources/declared/nextcloud.js and triggerBus/ncPayload.mts.
 * This table is the only place that knows both shapes. A path it does not
 * list answers null, and the caller turns that into an AI item.
 *
 * `authentication.*` disappears: Bee Flow's connector supplies the identity.
 * Paths: Windmill's `event.node.path` is the internal `/<uid>/files/<path>`;
 * Bee Flow's `path` is relative to the user's files. Mapped with a medium
 * confidence because of that.
 */

import type { Seg } from './mapExpr.mts';
import { familyOf } from './eventClasses.mts';

type Family = ReturnType<typeof familyOf>;

const EVENT_FIELDS: Record<Family, Record<string, { field: string; medium?: boolean }>> = {
    file: { 'node.path': { field: 'path', medium: true }, 'node.id': { field: 'id' }, 'node.name': { field: 'name' } },
    tag: { tagId: { field: 'tagId' }, objectIds: { field: 'objectIds' }, objectType: { field: 'objectType' } },
    forms: {
        'form.id': { field: 'formId' }, 'form.hash': { field: 'formHash' }, 'form.title': { field: 'formTitle' },
        'form.ownerId': { field: 'formOwner' }, 'submission.id': { field: 'submissionId' },
        'submission.formId': { field: 'formId' }, 'submission.userId': { field: 'submittedBy' },
    },
    tables: { tableId: { field: 'tableId' }, rowId: { field: 'rowId' }, values: { field: 'values' }, previousValues: { field: 'previousValues' } },
    calendar: { calendarId: { field: 'calendarId' } },
    deck: { 'card.id': { field: 'cardId' }, 'card.title': { field: 'title' } },
    mail: {},
    other: {},
};

export type PayloadPath = { field: string; rest: Seg[]; medium: boolean } | { identity: true } | null;

/** `flow_input.<segs>` of a Nextcloud-triggered flow as a Bee Flow trigger field, or null. */
export function nextcloudPayloadPath(event: string, segs: Seg[]): PayloadPath {
    const head = segs[0];
    if (!head || head.kind === 'index') return null;
    if (head.v === 'authentication') return authField(segs.slice(1));
    if (head.v === 'user') return userField(segs.slice(1));
    if (head.v !== 'event') return null;
    const table = EVENT_FIELDS[familyOf(event)];
    for (let n = Math.min(3, segs.length - 1); n >= 1; n -= 1) {
        const key = segs.slice(1, 1 + n).map((s) => String(s.v)).join('.');
        const hit = table[key];
        if (hit) return { field: hit.field, rest: segs.slice(1 + n), medium: hit.medium === true };
    }
    return null;
}

/**
 * `authentication.trigger.userId` names the user who caused the event: that is
 * the trigger's `actor`. Everything else under `authentication` is the
 * connection itself, which Bee Flow's connector supplies.
 */
function authField(segs: Seg[]): PayloadPath {
    if (segs[0]?.v === 'trigger' && segs[1]?.v === 'userId' && segs.length === 2) return { field: 'actor', rest: [], medium: true };
    return { identity: true };
}

function userField(segs: Seg[]): PayloadPath {
    const first = segs[0];
    if (!first) return null;
    if (first.v === 'uid') return { field: 'actor', rest: segs.slice(1), medium: false };
    if (first.v === 'displayName') return { field: 'actorName', rest: segs.slice(1), medium: true };
    return null;
}

/** Strip the `/<uid>/files` prefix of a Nextcloud internal path; null when it is not one. */
export function relativeNcPath(internal: string): string | null {
    if (!internal.startsWith('/')) return null;
    const second = internal.indexOf('/', 1);
    if (second === -1) return null;
    const rest = internal.slice(second);
    if (rest === '/files') return '/';
    if (!rest.startsWith('/files/')) return null;
    return rest.slice('/files'.length);
}
