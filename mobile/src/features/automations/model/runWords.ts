/**
 * The machine words on a run — what started it, and the class of error it
 * died of — as a person reads them, in the app's language.
 *
 * The tables are the web's (agent-hub Studio/Executions/runLanguage.js,
 * TRIGGER_LABELS and ERROR_CLASS_LABELS), word for word, under the phone's
 * `mobile.runs.*` keys. They live here rather than in features/runs, which
 * ports the rest of that module, because the runs feature already imports
 * this one (the status table): automations reaching back into runs would be
 * a feature cycle. runs/model/runLanguage.ts re-exports them, and its
 * differential lockstep test holds them to the web.
 *
 * Before this the run screens printed the tokens: "app_event", "manual_step",
 * "rate_limit" — English code words in a Dutch app.
 */

import type { TranslateFn } from '@/core/i18n';

/** A phrase as its i18n key, English fallback and placeholders. */
export interface Words {
    key: string;
    en: string;
    params?: Record<string, string | number>;
}

/** The trigger kind as a person reads it — the web's "Started by" column. */
const TRIGGER_WORDS: Readonly<Record<string, Words>> = Object.freeze({
    schedule: { key: 'mobile.runs.trigger.schedule', en: 'On a schedule' },
    cron: { key: 'mobile.runs.trigger.schedule', en: 'On a schedule' },
    manual: { key: 'mobile.runs.trigger.manual', en: 'Started by hand' },
    manual_step: { key: 'mobile.runs.trigger.manual', en: 'Started by hand' },
    dry_run: { key: 'mobile.runs.trigger.dry_run', en: 'Test run' },
    form: { key: 'mobile.runs.trigger.form', en: 'Someone filled in the form' },
    form_page: { key: 'mobile.runs.trigger.form', en: 'Someone filled in the form' },
    app_event: { key: 'mobile.runs.trigger.app_event', en: 'An app event' },
    chat: { key: 'mobile.runs.trigger.chat', en: 'Asked from chat' },
    agent: { key: 'mobile.runs.trigger.chat', en: 'Asked from chat' },
    webhook: { key: 'mobile.runs.trigger.webhook', en: 'A webhook — another system called this' },
});

/**
 * Kinds the server records that the web's table does not name, in the words
 * the phone's run rows already used for them. Kept apart from TRIGGER_WORDS
 * so `triggerWords` stays the web's table exactly.
 */
const PHONE_TRIGGER_WORDS: Readonly<Record<string, Words>> = Object.freeze({
    agent_call: { key: 'mobile.runs.trigger.agent_call', en: 'Called by an agent' },
    studio_app: { key: 'mobile.runs.trigger.studio_app', en: 'From an app' },
});

/** The typed error class, in plain words (null for classes that have none). */
const ERROR_CLASS_WORDS: Readonly<Record<string, Words>> = Object.freeze({
    auth: { key: 'mobile.runs.error_class.auth', en: 'a connection is no longer signed in' },
    connection: { key: 'mobile.runs.error_class.connection', en: 'a connected app could not be reached' },
    network: { key: 'mobile.runs.error_class.connection', en: 'a connected app could not be reached' },
    timeout: { key: 'mobile.runs.error_class.timeout', en: 'it took too long and was stopped' },
    rate_limit: { key: 'mobile.runs.error_class.rate_limit', en: 'a connected app asked us to slow down' },
    validation: { key: 'mobile.runs.error_class.validation', en: 'a step received data it could not accept' },
    permission: { key: 'mobile.runs.error_class.permission', en: 'a permission was missing' },
    cancelled: { key: 'mobile.runs.error_class.cancelled', en: 'someone stopped it' },
});

/** Own keys only: "constructor" must not answer with Object's. */
function lookup(table: Readonly<Record<string, Words>>, raw: string | null | undefined): Words | null {
    const key = String(raw ?? '').toLowerCase();
    return key && Object.hasOwn(table, key) ? (table[key] ?? null) : null;
}

/** The trigger as words (the web's table), or null for a kind it does not name. */
export function triggerWords(kind: string | null | undefined): Words | null {
    return lookup(TRIGGER_WORDS, kind);
}

/** The error class as words (the web's table), or null for a class it does not name. */
export function errorClassWords(errorClass: string | null | undefined): Words | null {
    return lookup(ERROR_CLASS_WORDS, errorClass);
}

/**
 * What started a run, translated: the web's words, then the phone's for the
 * kinds the web does not name, then the kind with its underscores spaced out
 * — never the raw token.
 */
export function triggerText(kind: string | null | undefined, t: TranslateFn): string {
    if (!kind) return '—';
    const words = triggerWords(kind) ?? lookup(PHONE_TRIGGER_WORDS, kind);
    return words ? t(words.key, words.en) : String(kind).replace(/_/g, ' ');
}

/** Why a run failed, translated, or null for a class nobody has put into words. */
export function errorClassText(errorClass: string | null | undefined, t: TranslateFn): string | null {
    const words = errorClassWords(errorClass);
    return words ? t(words.key, words.en) : null;
}
