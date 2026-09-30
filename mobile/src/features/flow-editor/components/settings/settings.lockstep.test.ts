/**
 * Lockstep: the routine's notification settings against the web's Settings
 * page (handoff 5: Builder/settings/, which replaced SettingsTab.jsx).
 *
 *   DIFFERENTIAL  normalizeNotificationSettings, toggleChannel and
 *                 recipientKey beside notificationSettings.ts (required as it
 *                 is), over stored policies of both shapes; the event words
 *                 (eventTitle, eventQualifier, channelLabel, urgencyLabel,
 *                 recipientLabel, summary, throttleLabel) cut out of
 *                 NotificationEventEditor.tsx — a component file, so not
 *                 requirable — with their parameter types dropped, run
 *                 beside the port;
 *   TEXTUAL       every `routines.notify.*` word the phone says is the web's,
 *                 key and English, and every one the web says is the phone's
 *                 but the few that belong to the wide table.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
    CHANNELS, channelLabel, eventQualifier, eventSummary, eventTitle, EVENTS, normalizeNotificationSettings, recipientKey, recipientLabel,
    THROTTLE_OPTIONS, throttleLabel, toggleChannel, URGENCIES, urgencyLabel, whoLine, type Recipient,
} from './notificationsModel';

const SETTINGS = path.resolve(__dirname, '../../../../../../agent-hub/src/components/automation/Builder/settings');
const EDITOR = fs.readFileSync(`${SETTINGS}/NotificationEventEditor.tsx`, 'utf8');
const SECTION = fs.readFileSync(`${SETTINGS}/NotificationsSection.tsx`, 'utf8');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require(`${SETTINGS}/notificationSettings.ts`);

type Fn = (...args: unknown[]) => unknown;

/** A function of the editor file: its TypeScript signature swapped for `js`, its body (plain JS) kept. */
function editorFunction(signature: string, js: string, deps: Record<string, unknown> = {}): Fn {
    const start = EDITOR.indexOf(signature);
    if (start < 0) throw new Error(`NotificationEventEditor.tsx no longer contains: ${signature}`);
    const open = start + signature.length - 1;
    let depth = 0;
    for (let i = open; i < EDITOR.length; i++) {
        if (EDITOR[i] === '{') depth++;
        if (EDITOR[i] === '}' && --depth === 0) {
            return new Function(...Object.keys(deps), `return function ${js} ${EDITOR.slice(open, i + 1)};`)(...Object.values(deps)) as Fn;
        }
    }
    throw new Error(`unbalanced body after ${signature}`);
}

const webChannelLabel = editorFunction('export function channelLabel(c: Channel, t: T, short = false): string {', 'channelLabel(c, t, short = false)');
const webUrgencyLabel = editorFunction('function urgencyLabel(u: Urgency, t: T): string {', 'urgencyLabel(u, t)');
const webRecipientLabel = editorFunction(
    'export function recipientLabel(r: Recipient, t: T, ownerName: string, names: Map<string, string>): string {',
    'recipientLabel(r, t, ownerName, names)',
    { recipientKey: web.recipientKey },
);
const webWords = {
    eventTitle: editorFunction('export function eventTitle(event: NotificationEvent, t: T): string {', 'eventTitle(event, t)'),
    eventQualifier: editorFunction(
        'export function eventQualifier(event: NotificationEvent, t: T, value?: EventSettings, digestOn = false): string {',
        'eventQualifier(event, t, value, digestOn = false)',
    ),
    summary: editorFunction(
        'function summary(value: EventSettings, t: T, ownerName: string, names: Map<string, string>): string {',
        'summary(value, t, ownerName, names)',
        { channelLabel: webChannelLabel, recipientLabel: webRecipientLabel, urgencyLabel: webUrgencyLabel },
    ),
    throttleLabel: editorFunction('function throttleLabel(n: number | null, t: T): string {', 'throttleLabel(n, t)'),
};

const english = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));
const keyed = (key: string, fallback: string, params?: Record<string, string | number>) => `${key}|${english(key, fallback, params)}`;

const seat = (type: string, id?: unknown) => (id === undefined ? { type } : { type, id });
const STORED: unknown[] = [
    undefined, null, {}, 'x', [],
    // The pre-handoff-5 shape: a level, the old channel names, a Talk room.
    { onSuccess: { enabled: true } },
    { onError: { enabled: false, level: 'bogus', channels: ['email', 'slack', 'email'] } },
    { onApproval: { level: 'info', channels: ['nc_talk'], ncTalkRoom: ' room-1 ' }, extra: 1 },
    { onSuccess: { enabled: 'yes', level: 'urgent', channels: 'email' }, onError: null },
    { onError: { channels: ['inapp', 'nc_notification', 'notification'] }, onApproval: { level: 'heads_up', throttle: { maxPerHour: 3 } } },
    { onError: { channels: ['constructor', 'email'] } },
    // The handoff-5 shape, and every way a hand-edited one can be wrong.
    {
        onError: { enabled: true, channels: ['talk', 'bell'], recipients: [seat('owner'), seat('owner'), seat('user', ' u1 '), seat('group', 'g1'), seat('user', ''), seat('user', 5), seat('robot')], urgency: 'silent', throttle: { maxPerHour: 2.7 }, delivery: 'digest' },
        onApproval: { recipients: 'x', urgency: 'loud', throttle: { maxPerHour: 0 }, delivery: 'later', talkRoom: 'r'.repeat(201) },
        onSuccess: { recipients: [], throttle: { maxPerHour: 99 } },
        digest: { enabled: true, time: '07:30' },
    },
    { onError: { recipients: Array.from({ length: 25 }, (_, i) => seat('user', `u${i}`)), throttle: { maxPerHour: null } }, digest: { enabled: 'yes', time: '25:00' } },
    { onApproval: { throttle: { maxPerHour: 'x' }, talkRoom: ' t ' }, onSuccess: { throttle: {}, channels: [] }, digest: { time: 7 } },
    { onError: { throttle: 5 }, onSuccess: { urgency: 'urgent', level: 'info' } },
];

describe('the notification policy', () => {
    it('has the web events, channels and urgencies', () => {
        expect([...EVENTS]).toEqual([...web.EVENTS]);
        expect([...CHANNELS]).toEqual([...web.CHANNELS]);
        expect([...URGENCIES]).toEqual([...web.URGENCIES]);
        // The overview lists the events in this order, as does the phone.
        expect(SECTION).toMatch(/\{EVENTS\.map\(\(event(?:, i)?\) => \(\s*<OverviewRow/);
    });

    it.each(STORED.map((s, i) => [i, s] as const))('normalises case %i as the web does', (_i, stored) => {
        expect(normalizeNotificationSettings(stored)).toStrictEqual(web.normalizeNotificationSettings(stored));
    });

    it('toggles a channel as the web does, off with the last one', () => {
        for (const stored of STORED) {
            const settings = normalizeNotificationSettings(stored);
            for (const event of EVENTS) {
                for (const channel of CHANNELS) {
                    expect(toggleChannel(settings[event], channel)).toStrictEqual(web.toggleChannel(settings[event], channel));
                }
            }
        }
    });

    it('keys recipients as the web does', () => {
        const all: Recipient[] = [{ type: 'owner' }, { type: 'approver' }, { type: 'user', id: 'u' }, { type: 'group', id: 'g' }];
        for (const r of all) expect(recipientKey(r)).toBe(web.recipientKey(r));
    });
});

describe('the words', () => {
    const names = new Map([['user:u1', 'Ada'], ['group:g1', 'Finance']]);
    const recipients: Recipient[] = [{ type: 'owner' }, { type: 'approver' }, { type: 'user', id: 'u1' }, { type: 'user', id: 'zz' }, { type: 'group', id: 'g1' }, { type: 'group', id: 'zz' }];

    it.each([english, keyed].map((t, i) => [i ? 'keys' : 'English', t] as const))('say what the web says (%s)', (_label, t) => {
        for (const event of EVENTS) {
            expect(eventTitle(event, t)).toBe(webWords.eventTitle(event, t));
            for (const stored of STORED) {
                const settings = normalizeNotificationSettings(stored);
                for (const digestOn of [false, true]) {
                    expect(eventQualifier(event, t, settings[event], digestOn)).toBe(webWords.eventQualifier(event, t, settings[event], digestOn));
                }
                expect(eventSummary(settings[event], t, 'Grace', names)).toBe(webWords.summary(settings[event], t, 'Grace', names));
            }
            expect(eventQualifier(event, t)).toBe(webWords.eventQualifier(event, t));
        }
        for (const c of CHANNELS) for (const short of [false, true]) expect(channelLabel(c, t, short)).toBe(webChannelLabel(c, t, short));
        for (const u of URGENCIES) expect(urgencyLabel(u, t)).toBe(webUrgencyLabel(u, t));
        for (const r of recipients) expect(recipientLabel(r, t, 'Grace', names)).toBe(webRecipientLabel(r, t, 'Grace', names));
        for (const n of THROTTLE_OPTIONS) expect(throttleLabel(n, t)).toBe(webWords.throttleLabel(n, t));
    });

    it('offers the web repeat limits and names who gets an event as the overview does', () => {
        const options = /const THROTTLE_OPTIONS: Array<number \| null> = (\[[^\]]*\]);/.exec(EDITOR)?.[1];
        expect([...THROTTLE_OPTIONS]).toEqual(JSON.parse(options ?? 'null'));
        expect(SECTION).toContain("const who = value.enabled && value.channels.length\n        ? value.recipients.map(r => recipientLabel(r, t, ownerName, names)).join(', ')\n        : '';");
        const on = normalizeNotificationSettings({ onError: { recipients: [{ type: 'owner' }, { type: 'user', id: 'u1' }] } }).onError;
        expect(whoLine(on, english, 'Grace', names)).toBe('Grace (owner), Ada');
        expect(whoLine({ ...on, enabled: false }, english, 'Grace', names)).toBe('');
        expect(whoLine({ ...on, channels: [] }, english, 'Grace', names)).toBe('');
    });
});

describe('the words are the web words', () => {
    const PAIR = /\bt\(\s*'(routines\.(?:notify|settings)\.[a-z_]+)',\s*'((?:[^'\\]|\\.)*)'/g;
    const pairs = (src: string) => new Map([...src.matchAll(PAIR)].map((m) => [m[1] as string, m[2] as string]));
    const webPairs = pairs(EDITOR + SECTION);
    const phone = pairs(['notificationsModel.ts', 'NotificationsGroup.tsx', 'NotificationEventDetails.tsx'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n'));

    /** On the wide table and the save round trip only: the phone folds like the web's narrow view and saves through the draft. */
    const WEB_ONLY = ['routines.notify.when', 'routines.notify.who', 'routines.settings.save_failed'];

    it('every phone word is the web one, key and English', () => {
        expect(phone.size).toBeGreaterThan(30);
        for (const [key, en] of phone) expect({ key, en }).toEqual({ key, en: webPairs.get(key) });
    });

    it('every web word is on the phone', () => {
        const missing = [...webPairs.keys()].filter((k) => !phone.has(k) && !WEB_ONLY.includes(k));
        expect({ missing }).toEqual({ missing: [] });
        for (const key of WEB_ONLY) expect(webPairs.has(key)).toBe(true);
    });
});
