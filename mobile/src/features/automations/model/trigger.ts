/**
 * What starts a routine, in words and as a glyph.
 */

import type { IconName } from '@/shared/ui';

import { describeCron } from './cron';
import type { AutomationTrigger } from './types';

/** Fixed sentences per trigger kind; `schedule` and `app_event` are composed. */
const TRIGGER_SENTENCES: Readonly<Record<string, string>> = {
    manual: 'Runs when you start it',
    webhook: 'Runs when its webhook URL is called',
    form: 'Runs when someone submits its form',
    agent_call: 'Runs when an AI agent calls it',
};

function describeAppEvent(appEvent: AutomationTrigger['appEvent']): string {
    const provider = appEvent?.provider ?? 'an app';
    const event = appEvent?.event ?? 'an event';
    const filtered = appEvent?.filter ? ', filtered' : '';
    return `Runs on ${provider} “${event}”${filtered}`;
}

/**
 * One line saying what starts this routine. A port of
 * server/automation/summarise.js describeTrigger(), minus its markdown —
 * the phone reads it aloud to a screen reader, and backticks do not read.
 */
export function describeTrigger(trigger: AutomationTrigger | null | undefined): string {
    if (!trigger?.kind) return 'Runs when you start it';
    if (trigger.kind === 'schedule') {
        return describeCron(trigger.schedule?.cron ?? null, trigger.schedule?.tz ?? null);
    }
    if (trigger.kind === 'app_event') return describeAppEvent(trigger.appEvent);
    // Own-property lookup: a kind of 'constructor' must not read Object.prototype.
    if (Object.prototype.hasOwnProperty.call(TRIGGER_SENTENCES, trigger.kind)) {
        return TRIGGER_SENTENCES[trigger.kind] as string;
    }
    return `Runs on ${trigger.kind}`;
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
