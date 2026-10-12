/**
 * An automation's notification policy — when a run alerts someone, through which
 * channels, how urgently and to whom — as the web's Settings page edits it
 * (`definition.notificationSettings`, the handoff-5 shape). Port of agent-hub
 * `Builder/settings/notificationSettings.ts`, plus the words
 * NotificationEventEditor.tsx puts on it. Pure, pinned by
 * settings.lockstep.test.ts:
 *
 *   - any stored value (the new shape, the older one with a `level` and
 *     inapp/nc_talk channels, or nothing) reads as a complete policy, rule for
 *     rule the server's normalizeEventSettings, so an automation saved before this
 *     page keeps the choices it had;
 *   - switching an event's last channel off switches the event off;
 *   - the whole policy is written back, as the web saves it.
 *
 * The policy lives in the definition, so an edit here is a draft edit:
 * undoable, saved by the autosave.
 */

import type { ApprovalDirectory } from '@/features/flow-editor/api';
import { NOTIFICATION_DEFAULTS } from '@/features/flow-editor/formState/notificationDefaults';
import type { FlowDefinition, Translate } from '@/features/flow-editor/model';

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
/** The server keeps at most this many recipients per event. */
export const MAX_RECIPIENTS = 20;

export const NOTIFICATION_SETTINGS_DEFAULTS = NOTIFICATION_DEFAULTS as unknown as NotificationSettings;

const LEGACY_CHANNEL: Record<string, Channel> = { inapp: 'bell', nc_notification: 'bell', notification: 'bell', nc_talk: 'talk' };
const LEGACY_LEVEL: Record<string, Urgency> = { urgent: 'urgent', heads_up: 'normal', ai_task: 'normal', info: 'silent' };
const MAX_PER_HOUR = 60;

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

function channelsOf(v: unknown): Channel[] {
    if (!Array.isArray(v)) return [];
    const out = new Set<Channel>();
    for (const c of v) {
        const mapped = CHANNELS.includes(c as Channel) ? (c as Channel) : LEGACY_CHANNEL[String(c)];
        if (mapped) out.add(mapped);
    }
    return CHANNELS.filter((c) => out.has(c));
}

function recipientOf(r: unknown): Recipient | null {
    const o = obj(r);
    if (o.type === 'owner' || o.type === 'approver') return { type: o.type };
    if ((o.type === 'user' || o.type === 'group') && typeof o.id === 'string' && o.id.trim() && o.id.length <= 200) {
        return { type: o.type, id: o.id.trim() };
    }
    return null;
}

function recipientsOf(v: unknown): Recipient[] | null {
    if (!Array.isArray(v)) return null;
    const out: Recipient[] = [];
    const seen = new Set<string>();
    for (const r of v) {
        const next = recipientOf(r);
        if (!next || seen.has(recipientKey(next))) continue;
        seen.add(recipientKey(next));
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
    const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Obj) : null;
    if (!o || !('maxPerHour' in o)) return fallback;
    const n = o.maxPerHour;
    if (n === null) return null;
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    const whole = Math.floor(n);
    return whole < 1 ? null : Math.min(whole, MAX_PER_HOUR);
}

/** The pre-handoff-5 shape: no urgency and no recipients, and a `level` or an old channel name to prove it. */
function isLegacyEvent(o: Obj): boolean {
    if ('urgency' in o || 'recipients' in o) return false;
    return 'level' in o || (Array.isArray(o.channels) && o.channels.some((c) => String(c) in LEGACY_CHANNEL));
}

function urgencyOf(o: Obj, legacy: boolean, fallback: Urgency): Urgency {
    if (URGENCIES.includes(o.urgency as Urgency)) return o.urgency as Urgency;
    if (legacy && typeof o.level === 'string') return LEGACY_LEVEL[o.level] || fallback;
    return fallback;
}

function deliveryOf(o: Obj, legacy: boolean, fallback: Delivery): Delivery {
    if (o.delivery === 'direct' || o.delivery === 'digest') return o.delivery;
    return legacy ? 'direct' : fallback;
}

function talkRoomOf(o: Obj): string | null {
    const room = typeof o.talkRoom === 'string' ? o.talkRoom : o.ncTalkRoom;
    return typeof room === 'string' && room.trim() && room.trim().length <= 200 ? room.trim() : null;
}

function structuredCopy(e: EventSettings): EventSettings {
    return { ...e, channels: [...e.channels], recipients: e.recipients.map((r) => ({ ...r })), throttle: { ...e.throttle } };
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
        recipients: recipientsOf(o.recipients) ?? (legacy ? legacyRecipients : fallback.recipients.map((r) => ({ ...r }))),
        urgency: urgencyOf(o, legacy, fallback.urgency),
        throttle: { maxPerHour: legacy && !('throttle' in o) ? null : maxPerHourOf(o.throttle, fallback.throttle.maxPerHour) },
        delivery: deliveryOf(o, legacy, fallback.delivery),
    };
    const room = talkRoomOf(o);
    if (room) out.talkRoom = room;
    return out;
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
    const channels = on ? base.filter((c) => c !== channel) : CHANNELS.filter((c) => c === channel || base.includes(c));
    return { ...e, channels, enabled: channels.length > 0 };
}

/** A person or group picked from the directory (`u:<id>` / `g:<id>`), added once. */
export function addRecipient(e: EventSettings, picked: string): EventSettings {
    const id = picked.slice(2);
    const next: Recipient | null = picked.startsWith('u:') && id ? { type: 'user', id } : picked.startsWith('g:') && id ? { type: 'group', id } : null;
    if (!next || e.recipients.length >= MAX_RECIPIENTS || e.recipients.some((r) => recipientKey(r) === recipientKey(next))) return e;
    return { ...e, recipients: [...e.recipients, next] };
}

export function removeRecipient(e: EventSettings, r: Recipient): EventSettings {
    return { ...e, recipients: e.recipients.filter((x) => recipientKey(x) !== recipientKey(r)) };
}

/** The definition with its whole notification policy replaced (as the web saves it). */
export function withNotificationSettings(definition: FlowDefinition, next: NotificationSettings): FlowDefinition {
    return { ...definition, notificationSettings: next };
}

// ── Words (NotificationEventEditor.tsx) ─────────────────────────────────

export function eventTitle(event: NotificationEvent, t: Translate): string {
    if (event === 'onError') return t('automations.notify.event_error', 'Something goes wrong');
    if (event === 'onApproval') return t('automations.notify.event_approval', 'Someone must approve');
    return t('automations.notify.event_success', 'It worked');
}

/** "· summary" when the event only goes into the daily summary, "· right away" for errors otherwise. */
export function eventQualifier(event: NotificationEvent, t: Translate, value?: EventSettings, digestOn = false): string {
    if (value?.delivery === 'digest' && digestOn) return t('automations.notify.event_success_when', 'summary');
    if (event === 'onError') return t('automations.notify.event_error_when', 'right away');
    return '';
}

export function channelLabel(c: Channel, t: Translate, short = false): string {
    if (c === 'bell') return short ? t('automations.notify.channel_bell_short', 'Bell') : t('automations.notify.channel_bell', 'Bell in Nextcloud');
    if (c === 'email') return t('automations.notify.channel_email', 'Email');
    return t('automations.notify.channel_talk', 'Talk');
}

export function urgencyLabel(u: Urgency, t: Translate): string {
    if (u === 'silent') return t('automations.notify.urgency_silent', 'Silent');
    if (u === 'urgent') return t('automations.notify.urgency_urgent', 'Urgent');
    return t('automations.notify.urgency_normal', 'Normal');
}

/** A recipient in words. `names` resolves people and groups picked by id (`user:<id>` / `group:<id>`). */
export function recipientLabel(r: Recipient, t: Translate, ownerName: string, names: ReadonlyMap<string, string>): string {
    if (r.type === 'owner') return t('automations.notify.to_owner', '{name} (owner)', { name: ownerName });
    if (r.type === 'approver') return t('automations.notify.to_approver', 'The approver');
    const name = names.get(recipientKey(r));
    if (r.type === 'group') return name ? t('automations.notify.to_group', 'Group {name}', { name }) : t('automations.notify.to_group_unknown', 'A group');
    return name || t('automations.notify.to_person_unknown', 'A person');
}

/** People and groups by recipient key, from the automation's directory (GET /:id/principals). */
export function directoryNames(directory: ApprovalDirectory | null | undefined): Map<string, string> {
    return new Map([
        ...(directory?.members ?? []).map((m): [string, string] => [`user:${m.id}`, m.name]),
        ...(directory?.groups ?? []).map((g): [string, string] => [`group:${g.id}`, g.name]),
    ]);
}

/** The overview's "Who" cell: the recipients of an event that is on, else nothing. */
export function whoLine(value: EventSettings, t: Translate, ownerName: string, names: ReadonlyMap<string, string>): string {
    return value.enabled && value.channels.length
        ? value.recipients.map((r) => recipientLabel(r, t, ownerName, names)).join(', ')
        : '';
}

/** A collapsed event in one line: "Bell + Email · to Ada (owner) · urgent", or "off". */
export function eventSummary(value: EventSettings, t: Translate, ownerName: string, names: ReadonlyMap<string, string>): string {
    if (!value.enabled || !value.channels.length) return t('automations.notify.off', 'off');
    const via = value.channels.map((c) => channelLabel(c, t, true)).join(' + ');
    const to = value.recipients.map((r) => recipientLabel(r, t, ownerName, names)).join(', ');
    return [via, to && t('automations.notify.summary_to', 'to {who}', { who: to }), urgencyLabel(value.urgency, t).toLowerCase()]
        .filter(Boolean).join(' · ');
}

/** "On repeat": at most once or four times an hour, then bundled; or every time. */
export const THROTTLE_OPTIONS: readonly (number | null)[] = [1, 4, null];

export function throttleLabel(n: number | null, t: Translate): string {
    if (n == null) return t('automations.notify.repeat_every', 'Every time');
    if (n === 1) return t('automations.notify.repeat_once_hour', 'once per hour');
    return t('automations.notify.repeat_n_hour', '{n} times per hour', { n });
}

/** The example message an event sends, with the automation's own name in it. */
export function exampleMessage(event: NotificationEvent, title: string, t: Translate): { heading: string; body: string; link: string } {
    if (event === 'onError') {
        return {
            heading: t('automations.notify.example_error_title', '{title} has stopped', { title }),
            body: t('automations.notify.example_error_body', 'A step could not finish.'),
            link: t('automations.notify.example_error_link', 'View and fix'),
        };
    }
    if (event === 'onApproval') {
        return {
            heading: t('automations.notify.example_approval_title', '{title} needs your approval', { title }),
            body: t('automations.notify.example_approval_body', 'A step is waiting for your decision.'),
            link: t('automations.notify.example_approval_link', 'Open and decide'),
        };
    }
    return {
        heading: t('automations.notify.example_success_title', '{title} is done', { title }),
        body: t('automations.notify.example_success_body', 'All steps went well.'),
        link: t('automations.notify.example_success_link', 'View the run'),
    };
}
