/**
 * What starts an automation, in words and as a glyph.
 */

import { translate } from '@/core/i18n';
import type { IconName } from '@/shared/ui';

import { describeCron } from './cron';
import type { AutomationTrigger } from './types';

/** Fixed sentences per trigger kind; `schedule` and `app_event` are composed. */
const MANUAL = { i18nKey: 'mobile.automations.trigger.manual', en: 'Runs when you start it' };
const TRIGGER_SENTENCES: Readonly<Record<string, { i18nKey: string; en: string }>> = {
    manual: MANUAL,
    webhook: { i18nKey: 'mobile.automations.trigger.webhook', en: 'Runs when its webhook URL is called' },
    form: { i18nKey: 'mobile.automations.trigger.form', en: 'Runs when someone submits its form' },
    agent_call: { i18nKey: 'mobile.automations.trigger.agent_call', en: 'Runs when an AI agent calls it' },
};

function describeAppEvent(appEvent: AutomationTrigger['appEvent']): string {
    const provider = appEvent?.provider ?? translate('mobile.automations.trigger.an_app', 'an app');
    const event = appEvent?.event ?? translate('mobile.automations.trigger.an_event', 'an event');
    const sentence = translate('mobile.automations.trigger.app_event', 'Runs on {provider} “{event}”', { provider, event });
    return appEvent?.filter ? translate('mobile.automations.trigger.filtered', '{sentence}, filtered', { sentence }) : sentence;
}

/**
 * One line saying what starts this automation. A port of
 * server/automation/summarise.js describeTrigger(), minus its markdown —
 * the phone reads it aloud to a screen reader, and backticks do not read.
 */
export function describeTrigger(trigger: AutomationTrigger | null | undefined): string {
    if (!trigger?.kind) return translate(MANUAL.i18nKey, MANUAL.en);
    if (trigger.kind === 'schedule') {
        return describeCron(trigger.schedule?.cron ?? null, trigger.schedule?.tz ?? null);
    }
    if (trigger.kind === 'app_event') return describeAppEvent(trigger.appEvent);
    // Own-property lookup: a kind of 'constructor' must not read Object.prototype.
    if (Object.prototype.hasOwnProperty.call(TRIGGER_SENTENCES, trigger.kind)) {
        const sentence = TRIGGER_SENTENCES[trigger.kind] as { i18nKey: string; en: string };
        return translate(sentence.i18nKey, sentence.en);
    }
    return translate('mobile.automations.trigger.other', 'Runs on {kind}', { kind: trigger.kind });
}

/** The glyph for a trigger kind — the leading mark of every row. */
export function triggerIcon(kind: string | null | undefined): IconName {
    switch (kind) {
        case 'schedule':
            return 'Clock';
        case 'webhook':
            return 'Link';
        case 'form':
            return 'Clipboard';
        case 'agent_call':
            return 'Cpu';
        case 'app_event':
            return 'Inbox';
        default:
            return 'Play';
    }
}
