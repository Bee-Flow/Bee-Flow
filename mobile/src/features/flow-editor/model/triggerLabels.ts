/**
 * What a trigger is CALLED — a port of the web builder's flow/triggerLabels.js
 * (BFSF-339), pinned by labels.lockstep.test.ts.
 *
 * Two strings, kept apart on purpose:
 *   · the TYPE label ("Schedule trigger") — the muted kicker above the name;
 *   · the NAME ("Schedule") — what lands in `step.label` when Bee Flow names
 *     the node itself.
 */

/** kind → the muted type kicker. */
export const TRIGGER_TYPE_LABEL: Readonly<Record<string, string>> = {
    schedule: 'Schedule trigger',
    manual: 'Manual trigger',
    webhook: 'Webhook trigger',
    app_event: 'App-event trigger',
    agent_call: 'Agent trigger',
    layer_input: 'Flowlet input',
    app_trigger: 'Studio App trigger',
    form: 'Form trigger',
};

/** kind → the node's generated NAME. */
export const TRIGGER_NAME: Readonly<Record<string, string>> = {
    schedule: 'Schedule',
    manual: 'Manual',
    webhook: 'Webhook',
    app_event: 'App event',
    agent_call: 'Agent',
    layer_input: 'Flowlet input',
    app_trigger: 'Studio App',
    form: 'Form',
};

/** (provider.event) → a specific kicker: "New email (Gmail)". */
export const APP_EVENT_TYPE_LABEL: Readonly<Record<string, string>> = {
    'gmail.mail.new': 'New email (Gmail)',
    'gmail.label.added': 'Email labelled (Gmail)',
    'google-calendar.event.changed': 'Calendar event changed',
    'google-calendar.event.upcoming': 'Calendar event upcoming',
    'google-drive.file.new': 'New file (Drive)',
    'nextcloud.file.new': 'New file (Nextcloud)',
    'nextcloud.file.changed': 'File changed (Nextcloud)',
    'nextcloud.share.received': 'Share received (Nextcloud)',
    'nextcloud.activity.new': 'Nextcloud activity',
    'nextcloud.notification.new': 'Nextcloud notification',
};

interface TriggerLike {
    kind?: string;
    appEvent?: { provider?: string; event?: string } | null;
}

const lookup = (table: Readonly<Record<string, string>>, key: string | null | undefined) =>
    key && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

const appEventKey = (step: TriggerLike | null | undefined) =>
    step?.appEvent?.provider && step?.appEvent?.event ? `${step.appEvent.provider}.${step.appEvent.event}` : null;

/** The muted type kicker for a trigger step, app-event specialisation included. */
export function triggerTypeLabel(step: TriggerLike | null | undefined): string {
    const kind = step?.kind || 'manual';
    if (kind === 'app_event') {
        const specific = lookup(APP_EVENT_TYPE_LABEL, appEventKey(step));
        if (specific) return specific;
    }
    return lookup(TRIGGER_TYPE_LABEL, kind) || (TRIGGER_TYPE_LABEL.manual as string);
}

/** The name Bee Flow gives a trigger node of this kind (Manual's for anything unknown). */
export function defaultTriggerLabel(kind: unknown): string {
    return lookup(TRIGGER_NAME, typeof kind === 'string' ? kind : null) || (TRIGGER_NAME.manual as string);
}

const GENERATED_LABELS = new Set([
    ...Object.values(TRIGGER_TYPE_LABEL),
    ...Object.values(TRIGGER_NAME),
    ...Object.values(APP_EVENT_TYPE_LABEL),
    'Trigger',
]);

/**
 * True when `label` is a name Bee Flow produced rather than one a person
 * typed — the licence to rewrite it when the kind changes.
 */
export function isGeneratedTriggerLabel(label: unknown): boolean {
    const s = String(label ?? '').trim();
    return s === '' || GENERATED_LABELS.has(s);
}
