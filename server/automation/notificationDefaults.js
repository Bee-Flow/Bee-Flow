/**
 * Per-automation notification policy: the shape, the defaults and the reader.
 *
 * Stored under `definition.notificationSettings` (Studio → Automations
 * handoff 5, the Settings page's Notifications section):
 *
 *   {
 *     onError:    EventSettings,
 *     onApproval: EventSettings,
 *     onSuccess:  EventSettings,
 *     digest:     { enabled: boolean, time: 'HH:MM' },
 *   }
 *
 *   EventSettings = {
 *     enabled:    boolean,
 *     channels:   ('bell' | 'email' | 'talk')[],
 *     recipients: ({ type: 'owner' } | { type: 'approver' }
 *                  | { type: 'user', id } | { type: 'group', id })[],
 *     urgency:    'silent' | 'normal' | 'urgent',
 *     throttle:   { maxPerHour: number | null },
 *     delivery:   'direct' | 'digest',
 *     talkRoom?:  string,
 *   }
 *
 * The channels:
 *   bell   a Nextcloud notification for recipients whose organisation is
 *          connected to Nextcloud, the Bee Flow bell otherwise (and whenever
 *          the Nextcloud one cannot be delivered).
 *   email  a mail through the service mailbox, to each recipient with an
 *          address on file.
 *   talk   ONE message into a Talk conversation (talkRoom, else the org's
 *          approvals room). For an approval it is the reactable card.
 *
 * `delivery: 'digest'` keeps the event out of the direct channels and counts
 * it in the daily summary instead (the design's "Het is gelukt · samenvatting").
 * Without an enabled digest it falls back to direct, so nothing is ever lost.
 *
 * `throttle.maxPerHour`: at most that many messages per automation, event and
 * recipient in any rolling hour; the rest are bundled into one "n more"
 * message when the hour has passed (jobs/automationDigest.js). null = no cap.
 *
 * The older shape ({ enabled, level, channels: inapp|email|nc_talk|
 * nc_notification, ncTalkRoom }) is read by normalizeNotificationSettings, so
 * an automation saved before handoff 5 keeps behaving as it did. Nothing rewrites
 * stored rows: the next save from the Settings page writes the new shape.
 *
 * Mirrored as data in
 *   agent-hub/src/components/automation/Builder/notificationDefaults.js
 * (no shared package in this repo). notificationDefaults.test.js loads that
 * file and fails when the two disagree.
 */

'use strict';

const NOTIFICATION_EVENTS = Object.freeze(['onError', 'onApproval', 'onSuccess']);
const NOTIFICATION_CHANNELS = Object.freeze(['bell', 'email', 'talk']);
const NOTIFICATION_URGENCIES = Object.freeze(['silent', 'normal', 'urgent']);
const RECIPIENT_TYPES = Object.freeze(['owner', 'approver', 'user', 'group']);
const DELIVERY_MODES = Object.freeze(['direct', 'digest']);

/** Caps that keep a hand-edited definition from fanning out without bound. */
const MAX_RECIPIENTS = 20;
const MAX_PER_HOUR_LIMIT = 60;
const DEFAULT_DIGEST_TIME = '17:00';

const freezeEvent = (e) => Object.freeze({
    ...e,
    channels: Object.freeze([...e.channels]),
    recipients: Object.freeze(e.recipients.map(r => Object.freeze({ ...r }))),
    throttle: Object.freeze({ ...e.throttle }),
});

/**
 * Errors: bell + email to the owner, urgent, straight away (at most one an
 * hour, then bundled). Approvals: bell + Talk to whoever has to decide,
 * normal, every one of them. Success: off; switched on, it goes into the
 * daily summary rather than the bell.
 */
const NOTIFICATION_DEFAULTS = Object.freeze({
    onError: freezeEvent({
        enabled: true, channels: ['bell', 'email'], recipients: [{ type: 'owner' }],
        urgency: 'urgent', throttle: { maxPerHour: 1 }, delivery: 'direct',
    }),
    onApproval: freezeEvent({
        enabled: true, channels: ['bell', 'talk'], recipients: [{ type: 'approver' }],
        urgency: 'normal', throttle: { maxPerHour: null }, delivery: 'direct',
    }),
    onSuccess: freezeEvent({
        enabled: false, channels: ['bell'], recipients: [{ type: 'owner' }],
        urgency: 'silent', throttle: { maxPerHour: 1 }, delivery: 'digest',
    }),
    digest: Object.freeze({ enabled: false, time: DEFAULT_DIGEST_TIME }),
});

/** The pre-handoff-5 channel names, and what each one means now. */
const LEGACY_CHANNEL_MAP = Object.freeze({
    inapp: 'bell',
    notification: 'bell',
    nc_notification: 'bell',
    nc_talk: 'talk',
    email: 'email',
});

/** The pre-handoff-5 levels (bell categories) as an urgency. */
const LEGACY_LEVEL_TO_URGENCY = Object.freeze({
    urgent: 'urgent',
    heads_up: 'normal',
    ai_task: 'normal',
    info: 'silent',
});

/**
 * The Bee Flow bell's category for an urgency (notificationStore categories).
 * A success keeps the 'ai_task' category it always had.
 */
function urgencyToCategory(urgency, event = null) {
    if (urgency === 'urgent') return 'urgent';
    if (urgency === 'silent') return 'info';
    return event === 'onSuccess' ? 'ai_task' : 'heads_up';
}

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function channelsOf(raw) {
    if (!Array.isArray(raw)) return [];
    const picked = new Set();
    for (const c of raw) {
        const key = String(c);
        const mapped = NOTIFICATION_CHANNELS.includes(key) ? key : LEGACY_CHANNEL_MAP[key];
        if (mapped) picked.add(mapped);
    }
    return NOTIFICATION_CHANNELS.filter(c => picked.has(c));
}

/** A stable key for de-duplicating recipients. */
function recipientKey(r) {
    return r.id ? `${r.type}:${r.id}` : r.type;
}

function recipientsOf(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        if (!isPlainObject(item)) continue;
        let next = null;
        if (item.type === 'owner' || item.type === 'approver') next = { type: item.type };
        else if ((item.type === 'user' || item.type === 'group')
            && typeof item.id === 'string' && item.id.trim() && item.id.length <= 200) {
            next = { type: item.type, id: item.id.trim() };
        }
        if (!next) continue;
        const key = recipientKey(next);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(next);
        if (out.length >= MAX_RECIPIENTS) break;
    }
    return out;
}

function maxPerHourOf(raw, fallback) {
    if (!isPlainObject(raw)) return fallback;
    if (!('maxPerHour' in raw)) return fallback;
    const n = raw.maxPerHour;
    if (n === null) return null;
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    const whole = Math.floor(n);
    if (whole < 1) return null;
    return Math.min(whole, MAX_PER_HOUR_LIMIT);
}

function copyEvent(e) {
    return {
        enabled: e.enabled,
        channels: [...e.channels],
        recipients: e.recipients.map(r => ({ ...r })),
        urgency: e.urgency,
        throttle: { maxPerHour: e.throttle.maxPerHour },
        delivery: e.delivery,
        ...(e.talkRoom ? { talkRoom: e.talkRoom } : {}),
    };
}

/**
 * One event's settings, from the new shape, the old shape or nothing.
 *
 * Old shape: `level` becomes `urgency`, the channel names are mapped, the
 * recipients are the ones the old runner used (the owner; for approvals the
 * approver), no throttle (the old runner had none) and direct delivery.
 */
function normalizeEventSettings(raw, event) {
    const base = NOTIFICATION_DEFAULTS[event];
    if (!base) throw new Error(`unknown notification event: ${event}`);
    if (!isPlainObject(raw) || !Object.keys(raw).length) return copyEvent(base);

    const legacy = !('urgency' in raw) && !('recipients' in raw)
        && ('level' in raw || (Array.isArray(raw.channels) && raw.channels.some(c => c in LEGACY_CHANNEL_MAP && !NOTIFICATION_CHANNELS.includes(c))));

    const out = {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
        channels: 'channels' in raw ? channelsOf(raw.channels) : [...base.channels],
        recipients: recipientsOf(raw.recipients)
            ?? (legacy ? [{ type: event === 'onApproval' ? 'approver' : 'owner' }] : base.recipients.map(r => ({ ...r }))),
        urgency: NOTIFICATION_URGENCIES.includes(raw.urgency) ? raw.urgency
            : (legacy && typeof raw.level === 'string' ? (LEGACY_LEVEL_TO_URGENCY[raw.level] || base.urgency) : base.urgency),
        throttle: { maxPerHour: legacy && !('throttle' in raw) ? null : maxPerHourOf(raw.throttle, base.throttle.maxPerHour) },
        delivery: DELIVERY_MODES.includes(raw.delivery) ? raw.delivery : (legacy ? 'direct' : base.delivery),
    };
    const room = typeof raw.talkRoom === 'string' ? raw.talkRoom : raw.ncTalkRoom;
    if (typeof room === 'string' && room.trim() && room.trim().length <= 200) out.talkRoom = room.trim();
    return out;
}

function digestOf(raw) {
    const d = isPlainObject(raw) ? raw : {};
    const time = typeof d.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(d.time) ? d.time : DEFAULT_DIGEST_TIME;
    return { enabled: d.enabled === true, time };
}

/**
 * Any stored `notificationSettings` (new shape, old shape, partial, nothing)
 * as a complete settings object. Pure; never throws.
 */
function normalizeNotificationSettings(raw) {
    const src = isPlainObject(raw) ? raw : {};
    return {
        onError: normalizeEventSettings(src.onError, 'onError'),
        onApproval: normalizeEventSettings(src.onApproval, 'onApproval'),
        onSuccess: normalizeEventSettings(src.onSuccess, 'onSuccess'),
        digest: digestOf(src.digest),
    };
}

/**
 * Does this event go into the daily summary instead of the direct channels?
 * Only when the summary is actually on; otherwise it is delivered directly.
 */
function foldsIntoDigest(settings, event) {
    return settings?.[event]?.delivery === 'digest' && settings?.digest?.enabled === true;
}

module.exports = {
    NOTIFICATION_EVENTS,
    NOTIFICATION_CHANNELS,
    NOTIFICATION_URGENCIES,
    RECIPIENT_TYPES,
    DELIVERY_MODES,
    NOTIFICATION_DEFAULTS,
    LEGACY_CHANNEL_MAP,
    LEGACY_LEVEL_TO_URGENCY,
    MAX_RECIPIENTS,
    MAX_PER_HOUR_LIMIT,
    DEFAULT_DIGEST_TIME,
    urgencyToCategory,
    recipientKey,
    normalizeEventSettings,
    normalizeNotificationSettings,
    foldsIntoDigest,
};
