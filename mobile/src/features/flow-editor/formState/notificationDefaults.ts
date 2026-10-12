/**
 * Notification vocabulary for the builder: data only. Port of agent-hub
 * `Builder/notificationDefaults.js` (which mirrors
 * server/automation/notificationDefaults.js). Two surfaces use it:
 *
 *   - the automation's notification policy (`definition.notificationSettings`,
 *     the handoff-5 shape: per event its channels bell/email/talk, recipients,
 *     urgency, throttle and delivery, plus the daily digest), read and edited
 *     through components/settings/notificationsModel.ts;
 *   - a Notification STEP's `channels`, which speaks its own, older vocabulary
 *     ('inapp' | 'email'; the runner also accepts 'notification' for the
 *     bell). Those words travel as `labelEn` beside a `mobile.flow.channel.*`
 *     key and are rendered through `channelLabel`.
 *
 * Pinned by settings.lockstep.test.ts.
 */

import { translate as t } from '@/core/i18n';

export const NOTIFICATION_EVENTS = Object.freeze(['onError', 'onApproval', 'onSuccess']);
export const NOTIFICATION_CHANNELS = Object.freeze(['bell', 'email', 'talk']);
export const NOTIFICATION_URGENCIES = Object.freeze(['silent', 'normal', 'urgent']);
export const RECIPIENT_TYPES = Object.freeze(['owner', 'approver', 'user', 'group']);
export const DELIVERY_MODES = Object.freeze(['direct', 'digest']);
export const MAX_RECIPIENTS = 20;
export const MAX_PER_HOUR_LIMIT = 60;
export const DEFAULT_DIGEST_TIME = '17:00';

interface EventDefaults {
    enabled: boolean;
    channels: string[];
    recipients: { type: string }[];
    urgency: string;
    throttle: { maxPerHour: number | null };
    delivery: string;
}

const freezeEvent = (e: EventDefaults) => Object.freeze({
    ...e,
    channels: Object.freeze([...e.channels]),
    recipients: Object.freeze(e.recipients.map((r) => Object.freeze({ ...r }))),
    throttle: Object.freeze({ ...e.throttle }),
});

/**
 * Errors: bell + email to the owner, urgent, straight away (at most one an
 * hour). Approvals: bell + Talk to whoever decides, every one. Success: off;
 * switched on, it goes into the daily summary rather than the bell.
 */
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
export const LEGACY_CHANNEL_MAP: Readonly<Record<string, string>> = Object.freeze({
    inapp: 'bell',
    notification: 'bell',
    nc_notification: 'bell',
    nc_talk: 'talk',
    email: 'email',
});

/** The pre-handoff-5 levels as an urgency. */
export const LEGACY_LEVEL_TO_URGENCY: Readonly<Record<string, string>> = Object.freeze({
    urgent: 'urgent',
    heads_up: 'normal',
    ai_task: 'normal',
    info: 'silent',
});

// ── Notification STEP vocabulary ────────────────────────────────────────
// A notification step delivers on the Bee Flow bell ('inapp', always on) and
// email. No Nextcloud channels here: a step cannot send them (validate.js
// NOTIFICATION_STEP_CHANNELS).
export const VALID_CHANNELS: readonly string[] = Object.freeze(['inapp', 'email']);

export interface ChannelOption {
    key: string;
    labelEn: string;
    hintEn?: string;
    always?: boolean;
}

export const CHANNEL_OPTIONS: readonly ChannelOption[] = Object.freeze([
    Object.freeze({ key: 'inapp', labelEn: 'In-app bell', always: true }),
    Object.freeze({ key: 'email', labelEn: 'Email' }),
]);

/** A channel option's words (and its hint, when it has one). */
export function channelLabel(option: ChannelOption): string {
    return t(`mobile.flow.channel.${option.key}`, option.labelEn);
}

export function channelHint(option: ChannelOption): string {
    return option.hintEn ? t(`mobile.flow.channel.${option.key}_hint`, option.hintEn) : '';
}

/** Short names for the canvas chips, where "notification" said nothing. */
export const CHANNEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
    inapp: 'In-app',
    notification: 'In-app',
    email: 'Email',
});

/** Known step channels only, the bell always first, de-duplicated. */
export function normalizeChannels(channels: unknown): string[] {
    const valid = Array.isArray(channels) ? channels.filter((c) => VALID_CHANNELS.includes(c)) : [];
    return Array.from(new Set(['inapp', ...valid]));
}

/** A notification STEP's `channels` in the pills' words: the step's `notification` is the bell. */
export function stepChannelsToUi(channels: unknown): string[] {
    const raw = Array.isArray(channels) && channels.length ? channels : ['inapp'];
    return normalizeChannels(raw.map((c) => (c === 'notification' ? 'inapp' : c)));
}

/**
 * The pills a notification step offers. Every surface offers the same two
 * now; the argument is the call sites' old scope and is not read.
 */
export function channelOptionsFor(_scope?: string): readonly ChannelOption[] {
    return CHANNEL_OPTIONS;
}
