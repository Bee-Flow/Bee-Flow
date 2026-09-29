/**
 * The per-routine notification policy as the Settings page edits it
 * (`definition.notificationSettings`, handoff 5 shape):
 *
 *   { onError|onApproval|onSuccess: { enabled, channels: ('bell'|'email'|'talk')[],
 *       recipients: ({type:'owner'}|{type:'approver'}|{type:'user',id}|{type:'group',id})[],
 *       urgency: 'silent'|'normal'|'urgent', throttle: { maxPerHour: number|null },
 *       delivery: 'direct'|'digest', talkRoom? },
 *     digest: { enabled, time: 'HH:MM' } }
 *
 * `normalizeNotificationSettings` also reads the older shape
 * (`{ enabled, level, channels: ['inapp'|'email'|'nc_talk'|'nc_notification'] }`),
 * so a routine saved before this page keeps the choices it had.
 * The defaults are quiet on success and loud on errors and approvals: the bell
 * stays calm unless someone has to act. They are the server's
 * (Builder/notificationDefaults.js mirrors server/automation/notificationDefaults.js,
 * and a server test keeps the two equal).
 */
import { NOTIFICATION_DEFAULTS } from '../notificationDefaults';

export type NotificationEvent = 'onError' | 'onApproval' | 'onSuccess';
export type Channel = 'bell' | 'email' | 'talk';
export type Urgency = 'silent' | 'normal' | 'urgent';
export type Delivery = 'direct' | 'digest';
export type Recipient =
    | { type: 'owner' }
    | { type: 'approver' }
    | { type: 'user'; id: string }
    | { type: 'group'; id: string };

export interface EventSettings {
    enabled: boolean;
    channels: Channel[];
    recipients: Recipient[];
    urgency: Urgency;
    throttle: { maxPerHour: number | null };
    /** 'digest': only in the daily summary (when that is on). Kept as stored. */
    delivery: Delivery;
    talkRoom?: string;
}

export interface NotificationSettings {
    onError: EventSettings;
    onApproval: EventSettings;
    onSuccess: EventSettings;
    digest: { enabled: boolean; time: string };
}

export const EVENTS: readonly NotificationEvent[] = ['onError', 'onApproval', 'onSuccess'];
export const CHANNELS: readonly Channel[] = ['bell', 'email', 'talk'];
export const URGENCIES: readonly Urgency[] = ['silent', 'normal', 'urgent'];

export const NOTIFICATION_SETTINGS_DEFAULTS = NOTIFICATION_DEFAULTS as unknown as NotificationSettings;

const LEGACY_CHANNEL: Record<string, Channel> = { inapp: 'bell', nc_notification: 'bell', notification: 'bell', nc_talk: 'talk' };
const LEGACY_LEVEL: Record<string, Urgency> = { urgent: 'urgent', heads_up: 'normal', ai_task: 'normal', info: 'silent' };
const MAX_RECIPIENTS = 20;
const MAX_PER_HOUR = 60;

function obj(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function channelsOf(v: unknown): Channel[] {
    if (!Array.isArray(v)) return [];
    const out = new Set<Channel>();
    for (const c of v) {
        const mapped = CHANNELS.includes(c as Channel) ? c as Channel : LEGACY_CHANNEL[String(c)];
        if (mapped) out.add(mapped);
    }
    return CHANNELS.filter(c => out.has(c));
}

function recipientsOf(v: unknown): Recipient[] | null {
    if (!Array.isArray(v)) return null;
    const out: Recipient[] = [];
    const seen = new Set<string>();
    for (const r of v) {
        const o = obj(r);
        let next: Recipient | null = null;
        if (o.type === 'owner' || o.type === 'approver') next = { type: o.type };
        else if ((o.type === 'user' || o.type === 'group') && typeof o.id === 'string' && o.id.trim() && o.id.length <= 200) {
            next = { type: o.type, id: o.id.trim() };
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

export function recipientKey(r: Recipient): string {
    return 'id' in r ? `${r.type}:${r.id}` : r.type;
}

/** The server's maxPerHourOf: whole 1..60, null or below 1 means no cap. */
function maxPerHourOf(raw: unknown, fallback: number | null): number | null {
    const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!o || !('maxPerHour' in o)) return fallback;
    const n = o.maxPerHour;
    if (n === null) return null;
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    const whole = Math.floor(n);
    return whole < 1 ? null : Math.min(whole, MAX_PER_HOUR);
}

/** The pre-handoff-5 shape: no urgency and no recipients, and a `level` or an old channel name to prove it. */
function isLegacyEvent(o: Record<string, unknown>): boolean {
    if ('urgency' in o || 'recipients' in o) return false;
    return 'level' in o || (Array.isArray(o.channels) && o.channels.some(c => String(c) in LEGACY_CHANNEL));
}

function urgencyOf(o: Record<string, unknown>, legacy: boolean, fallback: Urgency): Urgency {
    if (URGENCIES.includes(o.urgency as Urgency)) return o.urgency as Urgency;
    if (legacy && typeof o.level === 'string') return LEGACY_LEVEL[o.level] || fallback;
    return fallback;
}

function deliveryOf(o: Record<string, unknown>, legacy: boolean, fallback: Delivery): Delivery {
    if (o.delivery === 'direct' || o.delivery === 'digest') return o.delivery;
    return legacy ? 'direct' : fallback;
}

function talkRoomOf(o: Record<string, unknown>): string | null {
    const room = typeof o.talkRoom === 'string' ? o.talkRoom : o.ncTalkRoom;
    return typeof room === 'string' && room.trim() && room.trim().length <= 200 ? room.trim() : null;
}

/** Mirrors server/automation/notificationDefaults.js normalizeEventSettings, rule for rule. */
function eventOf(raw: unknown, fallback: EventSettings, event: NotificationEvent): EventSettings {
    const o = obj(raw);
    if (!Object.keys(o).length) return structuredCopy(fallback);
    const legacy = isLegacyEvent(o);
    const legacyRecipients: Recipient[] = [{ type: event === 'onApproval' ? 'approver' : 'owner' }];
    const out: EventSettings = {
        enabled: typeof o.enabled === 'boolean' ? o.enabled : fallback.enabled,
        channels: 'channels' in o ? channelsOf(o.channels) : [...fallback.channels],
        recipients: recipientsOf(o.recipients) ?? (legacy ? legacyRecipients : fallback.recipients.map(r => ({ ...r }))),
        urgency: urgencyOf(o, legacy, fallback.urgency),
        throttle: { maxPerHour: legacy && !('throttle' in o) ? null : maxPerHourOf(o.throttle, fallback.throttle.maxPerHour) },
        delivery: deliveryOf(o, legacy, fallback.delivery),
    };
    const room = talkRoomOf(o);
    if (room) out.talkRoom = room;
    return out;
}

function structuredCopy(e: EventSettings): EventSettings {
    return { ...e, channels: [...e.channels], recipients: e.recipients.map(r => ({ ...r })), throttle: { ...e.throttle } };
}

/** Any stored value (new shape, old shape, nothing) → a complete settings object. */
export function normalizeNotificationSettings(raw: unknown): NotificationSettings {
    const o = obj(raw);
    const digest = obj(o.digest);
    const time = typeof digest.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(digest.time) ? digest.time : '17:00';
    return {
        onError: eventOf(o.onError, NOTIFICATION_SETTINGS_DEFAULTS.onError, 'onError'),
        onApproval: eventOf(o.onApproval, NOTIFICATION_SETTINGS_DEFAULTS.onApproval, 'onApproval'),
        onSuccess: eventOf(o.onSuccess, NOTIFICATION_SETTINGS_DEFAULTS.onSuccess, 'onSuccess'),
        digest: { enabled: digest.enabled === true, time },
    };
}

/** Toggle one channel of one event. No channel left means the event is off. */
export function toggleChannel(e: EventSettings, channel: Channel): EventSettings {
    const on = e.enabled && e.channels.includes(channel);
    const base = e.enabled ? e.channels : [];
    const channels = on ? base.filter(c => c !== channel) : CHANNELS.filter(c => c === channel || base.includes(c));
    return { ...e, channels, enabled: channels.length > 0 };
}
