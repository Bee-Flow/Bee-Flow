/**
 * Notification vocabulary for the builder: data only.
 *
 * Two surfaces use it:
 *   - the automation's notification policy (`definition.notificationSettings`),
 *     mirrored from server/automation/notificationDefaults.js. Keep the two in
 *     sync by hand; server/automation/notificationDefaults.test.js loads this
 *     file and fails when they disagree.
 *   - a Notification STEP's `channels`, which speaks its own, older vocabulary
 *     ('inapp' | 'email', the runner also accepts 'notification' for the bell).
 *
 * Policy shape (see the server file for the full rules):
 *   { onError|onApproval|onSuccess: { enabled, channels: ('bell'|'email'|'talk')[],
 *       recipients: ({type:'owner'}|{type:'approver'}|{type:'user',id}|{type:'group',id})[],
 *       urgency: 'silent'|'normal'|'urgent', throttle: { maxPerHour: number|null },
 *       delivery: 'direct'|'digest', talkRoom? },
 *     digest: { enabled, time: 'HH:MM' } }
 */

const NOTIFICATION_EVENTS = Object.freeze(['onError', 'onApproval', 'onSuccess']);
const NOTIFICATION_CHANNELS = Object.freeze(['bell', 'email', 'talk']);
const NOTIFICATION_URGENCIES = Object.freeze(['silent', 'normal', 'urgent']);
const RECIPIENT_TYPES = Object.freeze(['owner', 'approver', 'user', 'group']);
const DELIVERY_MODES = Object.freeze(['direct', 'digest']);
const MAX_RECIPIENTS = 20;
const MAX_PER_HOUR_LIMIT = 60;
const DEFAULT_DIGEST_TIME = '17:00';

export type Channel = 'bell' | 'email' | 'talk';
export type Urgency = 'silent' | 'normal' | 'urgent';
export type Delivery = 'direct' | 'digest';
export type Recipient =
    | { type: 'owner' }
    | { type: 'approver' }
    | { type: 'user'; id: string }
    | { type: 'group'; id: string };

interface NotificationEvent {
    enabled: boolean;
    channels: readonly Channel[];
    recipients: readonly Recipient[];
    urgency: Urgency;
    throttle: { maxPerHour: number | null };
    delivery: Delivery;
}

const freezeEvent = (e: NotificationEvent) => Object.freeze({
    ...e,
    channels: Object.freeze([...e.channels]),
    recipients: Object.freeze(e.recipients.map(r => Object.freeze({ ...r }))),
    throttle: Object.freeze({ ...e.throttle }),
});

export const NOTIFICATION_DEFAULTS = Object.freeze({
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

/** The pre-handoff-5 levels as an urgency. */
const LEGACY_LEVEL_TO_URGENCY = Object.freeze({
    urgent: 'urgent',
    heads_up: 'normal',
    ai_task: 'normal',
    info: 'silent',
});

// ── Notification STEP vocabulary ────────────────────────────────────────
// A notification step delivers on the Bee Flow bell ('inapp', always on) and
// email; the runner calls the bell 'notification' on a step and accepts
// either (core/automationRunner/execOutbound.js). No Nextcloud channels here:
// a step cannot send them (validate.js NOTIFICATION_STEP_CHANNELS).
const VALID_CHANNELS = Object.freeze(['inapp', 'email']);

const CHANNEL_OPTIONS = Object.freeze([
    Object.freeze({ key: 'inapp', label: 'In-app bell', always: true }),
    Object.freeze({ key: 'email', label: 'Email' }),
]);

/** Short names for the canvas, where "notification" as a chip said nothing. */
export const CHANNEL_LABELS = Object.freeze({
    inapp: 'In-app',
    notification: 'In-app',
    email: 'Email',
});

/** A notification STEP's `channels`, in the vocabulary the pills speak. */
export function stepChannelsToUi(channels: unknown) {
    const raw = Array.isArray(channels) && channels.length ? channels : ['inapp'];
    return normalizeChannels(raw.map(c => (c === 'notification' ? 'inapp' : c)));
}

/** The pills a notification step offers. */
export function channelOptionsFor() {
    return CHANNEL_OPTIONS;
}

/** Known step channels only, the bell always included, de-duplicated. */
export function normalizeChannels(channels: unknown) {
    const valid = Array.isArray(channels) ? channels.filter(c => VALID_CHANNELS.includes(c)) : [];
    return Array.from(new Set(['inapp', ...valid]));
}
