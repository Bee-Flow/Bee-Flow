/**
 * "Find repeating work" in the Automations demo (Studio → Automations): the
 * source groups a scan can read, the viewer's last scan, a replay of a scan,
 * and the Not now / Not repetitive feedback.
 *
 * The shapes are the server's (server/routes/ai/automationBuilder/suggestions.js
 * and automation/patterns/pipeline.js `toSuggestion`): every number on a card
 * is one the miner measured, every template is already masked (`<n>`,
 * `<date>`, `<domain:d1>`), and nothing names a person, an address or a
 * real domain. Gmail is the demo org's one connection
 * (GET /api/integrations/connections in automations.js), so the patterns come
 * from mail and from Bee Flow's own chat activity.
 */

import { daysAgo } from './common';

type Obj = Record<string, unknown>;
type Ctx = { state: Obj; body: Obj | null; query: URLSearchParams };

const WINDOW_DAYS = 90;

/** What a scan read: the connected groups, as the client sends them. */
const SCANNED_SOURCES = ['mail', 'beeflow'];

const SOURCES = () => ({
    windowDays: WINDOW_DAYS,
    groups: [
        { id: 'mail', kind: 'live', connected: true, apps: [{ id: 'gmail', label: 'Gmail', connected: true }, { id: 'outlook', label: 'Outlook', connected: false }] },
        { id: 'calendar', kind: 'stored', connected: false, apps: [{ id: 'teams', label: 'Microsoft Teams', connected: false }] },
        { id: 'files', kind: 'live', connected: false, apps: [{ id: 'nextcloud', label: 'Nextcloud Files', connected: false }] },
        { id: 'beeflow', kind: 'stored', connected: true, apps: [{ id: 'chat', label: 'Chat activity', connected: true }, { id: 'documents', label: 'Knowledge uploads', connected: true }] },
    ],
});

const signal = (tool: string, integration: string, count: number, lastUsedDays: number) => ({ tool, integration, count, lastUsedDays });

/** Three patterns, best first, as the miner ranks them. Read-only: every route serialises a copy. */
const PATTERNS = [
    {
        id: 'pat_4f1c9a7e20b3',
        title: 'Log incoming purchase orders in a sheet',
        description: 'Purchase orders arrive by mail almost every weekday morning, and each one ends up as a row in a sheet.',
        requiredIntegrations: ['gmail', 'google-sheets'],
        unavailableIntegrations: ['google-sheets'],
        triggerKind: 'app_event',
        buildPrompt: 'Build an automation that starts when a purchase order email arrives in Gmail, extracts the order number, the customer and the order date, and appends one row per order to a Google Sheet.',
        groundedIn: 'activity',
        complexity: 'assisted',
        evidence: { kind: 'activity', signals: [signal('mail.received', 'gmail', 31, 1), signal('sheets_append_rows', 'google-sheets', 31, 1)], summary: `31× in the last ${WINDOW_DAYS} days` },
        value: { score: 86, minutesSavedPerMonth: 75, frequencyLabel: 'daily', confidence: 'high' },
        pattern: {
            kind: 'mail_template',
            signature: '4f1c9a7e20b3d58e61a0c7f2b94e3d1a',
            cadence: { kind: 'weekdays', perMonth: 10.3, weeksPresent: 12, weeksWindow: 13, hourBand: [9, 10] },
            occurrences: 31,
            windowDays: WINDOW_DAYS,
            distinctDays: 27,
            weekdayHistogram: [0, 7, 6, 6, 7, 5, 0],
            minutesPerMonth: [50, 100],
            basis: 'heuristic',
            template: 'Purchase order <id> from <domain:d1>',
            apps: ['gmail', 'google-sheets'],
            draft: {
                trigger: { kind: 'app', app: 'gmail', provider: 'gmail', event: 'mail.new', label: 'New email in Gmail' },
                steps: [{ family: 'ai', label: 'Extract the details' }, { family: 'app', app: 'google-sheets', label: 'Append rows' }],
            },
            reasons: ['frequent', 'regular', 'structuredInput', 'recent'],
            confidence: 'high',
        },
    },
    {
        id: 'pat_b27d03e9c4a1',
        title: 'Send the Friday status update',
        description: 'Every Friday afternoon you send the same status update, with only the week number changing.',
        requiredIntegrations: ['gmail'],
        unavailableIntegrations: [],
        triggerKind: 'schedule',
        buildPrompt: 'Build an automation that runs every Friday at 16:00, drafts the weekly status update with this week\'s number, and sends it from Gmail after I approve it.',
        groundedIn: 'activity',
        complexity: 'assisted',
        evidence: { kind: 'activity', signals: [signal('mail.sent', 'gmail', 12, 4)], summary: `12× in the last ${WINDOW_DAYS} days` },
        value: { score: 64, minutesSavedPerMonth: 60, frequencyLabel: 'weekly', confidence: 'high' },
        pattern: {
            kind: 'mail_template',
            signature: 'b27d03e9c4a16f58e2d90b7a3c14e85f',
            cadence: { kind: 'weekly', weekday: 5, hourBand: [16, 17], perMonth: 4.3, weeksPresent: 12, weeksWindow: 13 },
            occurrences: 12,
            windowDays: WINDOW_DAYS,
            distinctDays: 12,
            weekdayHistogram: [0, 0, 0, 0, 0, 12, 0],
            minutesPerMonth: [40, 80],
            basis: 'heuristic',
            template: 'Status update week <n>',
            apps: ['gmail'],
            draft: {
                trigger: { kind: 'schedule', label: 'Every week on Friday at 16:00' },
                steps: [{ family: 'ai', label: 'Draft the email' }, { family: 'app', app: 'gmail', label: 'Send the email' }],
            },
            reasons: ['regular', 'recent'],
            confidence: 'high',
        },
    },
    {
        id: 'pat_e90a6c2f17d8',
        title: 'Draft replies to delivery questions',
        description: 'A few times a week you ask Bee in chat to find a delivery question in Gmail, read it and draft a reply.',
        requiredIntegrations: ['gmail'],
        unavailableIntegrations: [],
        triggerKind: 'schedule',
        buildPrompt: 'Build an automation that runs on Monday, Wednesday and Friday at 10:00, searches Gmail for unanswered questions about delivery dates, reads each one and saves a draft reply for me to check.',
        groundedIn: 'activity',
        complexity: 'orchestrated',
        evidence: {
            kind: 'activity',
            signals: [signal('gmail_search', 'gmail', 9, 2), signal('gmail_read', 'gmail', 9, 2), signal('gmail_create_draft', 'gmail', 9, 2)],
            summary: `9× in the last ${WINDOW_DAYS} days`,
        },
        value: { score: 52, minutesSavedPerMonth: 38, frequencyLabel: 'weekly', confidence: 'medium' },
        pattern: {
            kind: 'sequence',
            signature: 'e90a6c2f17d84b3a95e0c1d7f26b8a4e',
            cadence: { kind: 'weekly', hourBand: [10, 11], perMonth: 3, weeksPresent: 8, weeksWindow: 13 },
            occurrences: 9,
            windowDays: WINDOW_DAYS,
            distinctDays: 9,
            weekdayHistogram: [0, 4, 0, 3, 0, 2, 0],
            minutesPerMonth: [30, 45],
            basis: 'measured',
            template: null,
            apps: ['gmail'],
            draft: {
                trigger: { kind: 'schedule', label: 'Every Monday, Wednesday and Friday at 10:00' },
                steps: [
                    { family: 'app', app: 'gmail', label: 'Search' },
                    { family: 'app', app: 'gmail', label: 'Read' },
                    { family: 'app', app: 'gmail', label: 'Create draft' },
                ],
            },
            reasons: ['multiStep', 'measuredEffort', 'recent'],
            confidence: 'normal',
        },
    },
];

const SUMMARY = (patterns: number) => ({
    sources: ['gmail', 'chat', 'documents'],
    events: 412,
    templates: 37,
    patterns,
    piiCategories: ['Person'],
});

/** The signatures this tab hid (Not now, Not repetitive), like the server's feedback rows. */
function hidden(state: Obj): Set<string> {
    if (!(state.repeatingHidden instanceof Set)) state.repeatingHidden = new Set<string>();
    return state.repeatingHidden as Set<string>;
}

const visible = (state: Obj) => PATTERNS.filter(s => !hidden(state).has(s.pattern.signature));

/** A finished patterns scan, as GET /suggest/last and the `done` frame carry it. */
function lastScan(state: Obj, scannedAt: string) {
    const suggestions = visible(state);
    return {
        suggestions,
        summary: SUMMARY(suggestions.length),
        scannedAt,
        eu: true,
        cached: true,
        mode: 'patterns',
        sources: SCANNED_SOURCES,
        focus: '',
    };
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** "Scan again": the scan replayed as the server streams it, phase by phase. */
function replayScan(state: Obj, body: Obj | null): Response {
    const mode = body?.mode === 'ideas' ? 'ideas' : 'patterns';
    const frames: string[] = [frame('model', { eu: true })];
    if (mode === 'ideas') {
        frames.push(frame('done', { suggestions: [], summary: { integrations: ['gmail'], toolCalls: 2, piiCategories: [] }, reason: 'no_patterns', cached: false, scannedAt: new Date().toISOString(), mode }));
    } else {
        const scan = lastScan(state, new Date().toISOString());
        frames.push(frame('phase', { phase: 'collecting' }));
        for (const [source, app, events] of [['mail', 'gmail', 268], ['beeflow', 'chat', 131], ['beeflow', 'documents', 13]] as const) {
            frames.push(frame('source_step', { source, app, status: 'start', events: 0 }));
            frames.push(frame('source_step', { source, app, status: 'done', events }));
        }
        frames.push(frame('phase', { phase: 'templating' }), frame('phase', { phase: 'mining' }));
        frames.push(frame('stats', { events: scan.summary.events, templates: scan.summary.templates, candidates: 5 }));
        frames.push(frame('phase', { phase: 'naming' }));
        for (const s of scan.suggestions) frames.push(frame('suggestion', { suggestion: s }));
        frames.push(frame('done', { ...scan, cached: false }));
    }
    return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

export const REPEATING_ROUTES = {
    'GET /api/automation/builder/suggest/sources': () => SOURCES(),
    // The viewer's last patterns scan; an ideas scan is never cached here (204).
    'GET /api/automation/builder/suggest/last': ({ state, query }: Ctx) => (
        query.get('mode') === 'ideas' ? null : lastScan(state, daysAgo(2))
    ),
    'POST /api/automation/builder/suggest': ({ state, body }: Ctx) => replayScan(state, body),
    'POST /api/automation/builder/feedback': ({ state, body }: Ctx) => {
        const signature = typeof body?.signature === 'string' ? body.signature : '';
        if (signature && (body?.action === 'dismissed' || body?.action === 'snoozed')) hidden(state).add(signature);
        return { ok: true };
    },
};
