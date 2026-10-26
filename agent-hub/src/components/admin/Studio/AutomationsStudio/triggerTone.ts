/**
 * What STARTS an automation, as a colour and a glyph: the anchor of a card,
 * a list row and a sidebar row in the automations library, so a page of forty
 * automations sorts itself by eye into "the scheduled ones", "the mail ones",
 * "the Nextcloud ones" before a title is read.
 *
 * Seven tones, derived from the trigger kinds the builder knows
 * (flow/triggerLabels: schedule, manual, webhook, app_event, agent_call,
 * layer_input, app_trigger, form) and, for app events, the provider:
 *
 *   schedule    a cron                                  --trigger-schedule
 *   manual      started by hand                         --trigger-manual
 *   mail        a mail event (Gmail, Outlook, …)        --trigger-mail
 *   nextcloud   any Nextcloud event                     --trigger-nextcloud
 *   form        a public form submission                --trigger-form
 *   app         a webhook, a Studio App button, an      --kind-app
 *               agent call, any other app event
 *   other       a flowlet input or a kind from a newer  neutral ink
 *               server
 *
 * Colour is never the only signal: every tone has its own glyph
 * (flow/triggerIcons, the canvas' map) and a label for assistive tech.
 *
 * Class strings are written out in full: Tailwind only generates what it can
 * read in the source.
 */
import { triggerIconKey } from '@/components/automation/Builder/flow/triggerIcons';
import type { AutomationDefinition, AutomationRecord } from './overviewModel';
import type { TranslateFn } from '@/hooks/useTranslation';

export const TRIGGER_TONES = Object.freeze(['schedule', 'manual', 'mail', 'nextcloud', 'form', 'app', 'other'] as const);
export type TriggerTone = typeof TRIGGER_TONES[number];

const APP_KINDS = new Set(['webhook', 'app_trigger', 'agent_call']);

/** The trigger as stored: the row's column first, the definition second. */
function triggerOf(a: AutomationRecord | null | undefined) {
    const def = (a?.definition as AutomationDefinition | null | undefined)?.trigger;
    const kind = a?.triggerType || def?.kind || 'manual';
    return { kind, appEvent: kind === 'app_event' ? def?.appEvent ?? null : null };
}

/** The tone of an automation's trigger. */
export function triggerToneOf(a: AutomationRecord | null | undefined): TriggerTone {
    const { kind, appEvent } = triggerOf(a);
    if (kind === 'schedule' || kind === 'manual' || kind === 'form') return kind;
    if (kind === 'app_event') {
        const provider = String(appEvent?.provider || '');
        const event = String(appEvent?.event || '');
        if (provider === 'nextcloud') return 'nextcloud';
        if (provider === 'gmail' || /^mail\./.test(event)) return 'mail';
        return 'app';
    }
    if (APP_KINDS.has(kind)) return 'app';
    return 'other';
}

/** The key of the trigger's glyph in flow/triggerIcons' TRIGGER_ICONS — the canvas trigger card's own map. */
export function triggerGlyphKeyOf(a: AutomationRecord | null | undefined): string {
    return triggerIconKey(triggerOf(a));
}

export interface ToneClasses {
    /** The icon tile: a calm tint with the glyph in the tone's ink. */
    tile: string;
    /** The glyph alone, on a neutral surface (a strip chip). */
    text: string;
    /** The 3px accent along a card's top edge. */
    accent: string;
}

export const TONE_CLASSES: Readonly<Record<TriggerTone, ToneClasses>> = Object.freeze({
    schedule: {
        tile: 'bg-[color-mix(in_srgb,var(--trigger-schedule)_14%,transparent)] text-[var(--trigger-schedule)]',
        text: 'text-[var(--trigger-schedule)]',
        accent: 'bg-[var(--trigger-schedule)]',
    },
    manual: {
        tile: 'bg-[color-mix(in_srgb,var(--trigger-manual)_14%,transparent)] text-[var(--trigger-manual)]',
        text: 'text-[var(--trigger-manual)]',
        accent: 'bg-[var(--trigger-manual)]',
    },
    mail: {
        tile: 'bg-[color-mix(in_srgb,var(--trigger-mail)_14%,transparent)] text-[var(--trigger-mail)]',
        text: 'text-[var(--trigger-mail)]',
        accent: 'bg-[var(--trigger-mail)]',
    },
    nextcloud: {
        tile: 'bg-[color-mix(in_srgb,var(--trigger-nextcloud)_14%,transparent)] text-[var(--trigger-nextcloud)]',
        text: 'text-[var(--trigger-nextcloud)]',
        accent: 'bg-[var(--trigger-nextcloud)]',
    },
    form: {
        tile: 'bg-[color-mix(in_srgb,var(--trigger-form)_14%,transparent)] text-[var(--trigger-form)]',
        text: 'text-[var(--trigger-form)]',
        accent: 'bg-[var(--trigger-form)]',
    },
    app: {
        tile: 'bg-[color-mix(in_srgb,var(--kind-app)_14%,transparent)] text-[var(--kind-app)]',
        text: 'text-[var(--kind-app)]',
        accent: 'bg-[var(--kind-app)]',
    },
    other: {
        tile: 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]',
        text: 'text-[var(--text-secondary)]',
        accent: 'bg-[var(--border-default)]',
    },
});

const TONE_LABEL: Readonly<Record<TriggerTone, [string, string]>> = Object.freeze({
    schedule: ['studio_misc.overview.tone_schedule', 'Schedule'],
    manual: ['studio_misc.overview.tone_manual', 'By hand'],
    mail: ['studio_misc.overview.tone_mail', 'Mail'],
    nextcloud: ['studio_misc.overview.tone_nextcloud', 'Nextcloud'],
    form: ['studio_misc.overview.tone_form', 'Form'],
    app: ['studio_misc.overview.tone_app', 'App or webhook'],
    other: ['studio_misc.overview.tone_other', 'Other trigger'],
});

/** The tone's short name ("Schedule", "By hand"); translated when a `t` is passed. */
export function toneLabelOf(tone: TriggerTone, t: TranslateFn | null | undefined): string {
    const [key, en] = TONE_LABEL[tone];
    return t ? t(key, en) : en;
}
