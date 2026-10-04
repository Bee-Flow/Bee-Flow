// @typecheck
'use strict';
/**
 * Builder mapping: a candidate's draft automation, trigger first.
 *
 * toDraft(c) → { trigger: { kind, app?, provider?, event?, label }, steps: [{ family, app?, label }] } | null
 *
 * Triggers map onto events that really exist: APP_TRIGGERS below names a
 * declared trigger source (automation/triggerSources/declared/*) per app, and
 * the table is checked against those declarations when this module loads, so
 * a renamed provider or event falls back to a schedule instead of drafting a
 * trigger the builder cannot make. Cadence-only patterns (a tool sequence, a
 * mail the user sends, a file the user creates) get a schedule trigger;
 * irregular ones a manual one.
 *
 * A draft trigger of kind 'app' carries `provider` and `event`: the builder's
 * `app_event` trigger takes exactly those as `appEvent: { provider, event }`
 * (automation/validate/graph.js).
 *
 * Labels are short English hints for the builder prompt and the card preview;
 * the LLM naming step and the client may restate them.
 *
 * No I/O beyond requiring the static declaration files.
 */

const DECLARED = [
    require('../triggerSources/declared/gmail'),
    require('../triggerSources/declared/msgraph'),
    require('../triggerSources/declared/nextcloud'),
    require('../triggerSources/declared/google-drive'),
    require('../triggerSources/declared/meeting-notes'),
];

/** provider id → Set of event ids, from the declarations. */
const DECLARED_EVENTS = new Map();
for (const mod of DECLARED) {
    const list = mod.TRIGGER_SOURCES || (mod.TRIGGER_SOURCE ? [mod.TRIGGER_SOURCE] : []);
    for (const src of list) DECLARED_EVENTS.set(src.id, new Set((src.events || []).map((e) => e.id)));
}

/**
 * Integration ids arrive in two spellings: the egress ledger writes
 * `google_drive` / `nextcloud_mail` (core/integrations/integrationToolMap.js),
 * the app catalogue and the trigger declarations say `google-drive` /
 * `nextcloud-mail`. Settle on the catalogue's: underscores become hyphens, and
 * the few ids that differ in more than that are aliased.
 */
const APP_ALIASES = {
    'ms-teams': 'teams',
    'google-meet': 'gmeet',
};
/** @param {string} app */
const normaliseApp = (app) => {
    const hyphen = String(app ?? '').replace(/_/g, '-');
    return APP_ALIASES[hyphen] || hyphen;
};

/** (app, pattern kind) → declared provider and event. */
const APP_TRIGGERS = {
    'gmail|mail_template': { provider: 'gmail', event: 'mail.new', label: 'New email in Gmail' },
    'outlook|mail_template': { provider: 'msgraph', event: 'mail.new', label: 'New email in Outlook' },
    'nextcloud|file_drop': { provider: 'nextcloud', event: 'file.new', label: 'New file in Nextcloud' },
    'google-drive|file_drop': { provider: 'google-drive', event: 'file.new', label: 'New file in Google Drive' },
    'onedrive|file_drop': { provider: 'msgraph', event: 'file.new', label: 'New file in OneDrive' },
    'teams|meeting_followup': { provider: 'meeting-notes', event: 'meeting.processed', label: 'Meeting notes ready' },
    'gmeet|meeting_followup': { provider: 'meeting-notes', event: 'meeting.processed', label: 'Meeting notes ready' },
    'meetings|meeting_followup': { provider: 'meeting-notes', event: 'meeting.processed', label: 'Meeting notes ready' },
};

/** Only entries whose provider and event are declared survive. */
function resolveAppTrigger(app, kind) {
    const t = APP_TRIGGERS[`${normaliseApp(app)}|${kind}`];
    if (!t) return null;
    return DECLARED_EVENTS.get(t.provider)?.has(t.event) ? t : null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Monday, Wednesday and Friday" from the histogram, when no single weekday dominates. */
function busyWeekdays(hist) {
    if (!Array.isArray(hist) || hist.length !== 7) return null;
    const max = Math.max(...hist);
    if (!(max > 0)) return null;
    // Monday first, the way people say it.
    const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => hist[d] >= max * 0.5).map((d) => WEEKDAYS[d]);
    if (days.length < 2 || days.length > 4) return null;
    return `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;
}

function scheduleLabel(cad) {
    const at = cad?.hourBand ? ` at ${String(cad.hourBand[0]).padStart(2, '0')}:00` : '';
    const day = cad?.weekday != null ? WEEKDAYS[cad.weekday] : null;
    if (cad?.kind === 'weekly' && !day) {
        const several = busyWeekdays(cad.weekdayHistogram);
        if (several) return `Every ${several}${at}`;
    }
    switch (cad?.kind) {
        case 'daily': return `Every day${at}`;
        case 'weekdays': return `Every weekday${at}`;
        case 'weekly': return `Every week${day ? ` on ${day}` : ''}${at}`;
        case 'biweekly': return `Every two weeks${day ? ` on ${day}` : ''}${at}`;
        case 'monthly': return `Every month${at}`;
        default: return null;
    }
}

/** Tool-name prefix → app id, for steps whose app is not otherwise known. */
const TOOL_PREFIXES = [
    ['nextcloud_mail_', 'nextcloud-mail'], ['nextcloud_', 'nextcloud'], ['gmail_', 'gmail'], ['outlook_', 'outlook'],
    ['sheets_', 'google-sheets'], ['drive_', 'google-drive'], ['onedrive_', 'onedrive'], ['teams_', 'teams'],
    ['calendar_', 'google-calendar'], ['slack_', 'slack'],
];

/**
 * "sheets_append_rows" → "Append rows". The longest prefix that names the app
 * goes: the app id itself ("nextcloud_tables_" for nextcloud-tables), any one
 * of its parts ("docs_" for google-docs), or a known tool prefix.
 */
function humaniseTool(verb, app = '') {
    const appId = String(app ?? '');
    const prefixes = [
        `${appId.replace(/-/g, '_')}_`,
        ...appId.split(/[-_]/).filter(Boolean).map((part) => `${part}_`),
        ...TOOL_PREFIXES.map(([p]) => p),
    ].filter((p) => p.length > 1 && verb.startsWith(p) && verb.length > p.length);
    const prefix = prefixes.sort((a, b) => b.length - a.length)[0] || '';
    const words = verb.slice(prefix.length).split(/[_\s]+/).filter(Boolean);
    if (!words.length) return verb;
    const s = words.join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
}

const READ_VERB_RE = /(?:^|_)(?:search|list|find|get|read|fetch|lookup)(?:_|$)/;
const LOCATE_VERB_RE = /(?:^|_)(?:search|list|find)(?:_|$)/;

const EVENT_VERB_LABELS = {
    'mail.sent': 'Send the email',
    'file.created': 'Save the file',
    'doc.uploaded': 'Upload the document',
};

/** The app a tool step belongs to when its event did not say. */
function appForVerb(verb, fallback) {
    for (const [p, app] of TOOL_PREFIXES) if (verb.startsWith(p)) return app;
    return fallback;
}

/** What a file-drop automation does with the file: create it where the user did. */
function fileDropSteps(c, app) {
    const kb = c.verbs?.[0] === 'doc.uploaded';
    return [
        { family: 'data', label: 'Collect the input' },
        { family: 'ai', label: 'Write the document' },
        { family: 'app', app, label: kb ? 'Add it to the knowledge base' : 'Save it in the same folder' },
    ];
}

/**
 * @param {any} c candidate
 * @returns {{ trigger: { kind: 'schedule'|'app'|'manual', app?: string, provider?: string, event?: string, label: string },
 *             steps: Array<{ family: 'app'|'ai'|'data'|'branch', app?: string, label: string }> } | null}
 */
function toDraft(c) {
    if (!c || !Array.isArray(c.verbs) || !c.verbs.length) return null;
    const verbs = c.verbs;
    const verbApps = Array.isArray(c.verbApps) && c.verbApps.length === verbs.length ? c.verbApps : verbs.map(() => c.apps?.[0]);

    // The anchor (what happens TO the user) becomes the trigger; the rest are
    // steps. A file the user creates is their own work, not an anchor: only a
    // file that ARRIVES (direction 'in') triggers.
    const anchored = verbs[0] === 'mail.received' || verbs[0] === 'meeting.held'
        || (c.kind === 'file_drop' && c.direction === 'in');
    const anchorApp = normaliseApp(verbApps[0] || c.apps?.[0] || '');

    /** @type {{ kind: 'schedule'|'app'|'manual', app?: string, provider?: string, event?: string, label: string }} */
    let trigger;
    const appTrig = anchored ? resolveAppTrigger(anchorApp, c.kind) : null;
    if (appTrig) {
        trigger = { kind: 'app', app: anchorApp, provider: appTrig.provider, event: appTrig.event, label: appTrig.label };
    } else {
        const label = scheduleLabel(c.cadence);
        trigger = label ? { kind: 'schedule', label } : { kind: 'manual', label: 'Run by hand' };
    }

    if (c.kind === 'file_drop') {
        const steps = anchored
            ? [{ family: 'ai', label: 'Read the file' }, { family: 'app', app: anchorApp, label: 'File it in the right place' }]
            : fileDropSteps(c, anchorApp);
        return { trigger, steps: /** @type {any} */ (steps) };
    }

    /** @type {Array<{ family: 'app'|'ai'|'data'|'branch', app?: string, label: string }>} */
    const steps = [];
    if (c.kind === 'meeting_followup') steps.push({ family: 'ai', label: 'Summarise the action items' });
    let extracted = false;
    let wrote = false;
    for (let i = anchored ? 1 : 0; i < verbs.length; i++) {
        const v = verbs[i];
        // The event's own app wins; the prefix table only fills a gap.
        const app = normaliseApp(verbApps[i] || appForVerb(v, anchorApp));
        const isWrite = !READ_VERB_RE.test(v);
        // How the user FOUND the mail is the trigger's job, not a step.
        if (trigger.kind === 'app' && !wrote && app === trigger.app && LOCATE_VERB_RE.test(v)) continue;
        // Structured input feeding a write: pull the fields out first.
        if (c.kind === 'mail_template' && c.structured && isWrite && !extracted && c.direction !== 'out') {
            steps.push({ family: 'ai', label: 'Extract the details' });
            extracted = true;
        }
        if (isWrite) wrote = true;
        const label = EVENT_VERB_LABELS[v] || humaniseTool(v, app);
        const prev = steps[steps.length - 1];
        if (prev && prev.label === label && prev.app === app) continue;
        steps.push({ family: 'app', app, label });
    }
    if (c.kind === 'mail_template' && c.direction === 'out') {
        steps.unshift({ family: 'ai', label: 'Draft the email' });
    }
    if (!steps.length) return null;
    return { trigger, steps: steps.slice(0, 6) };
}

module.exports = { toDraft, normaliseApp, resolveAppTrigger, humaniseTool, APP_TRIGGERS, DECLARED_EVENTS };
