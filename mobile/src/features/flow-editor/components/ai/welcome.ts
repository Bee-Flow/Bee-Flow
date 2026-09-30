/**
 * What the assistant offers before the first message — the web's
 * AssistantWelcome.jsx: three suggestions that FILL the composer (never
 * send), the first one fitting the routine's trigger. Pinned by
 * ai.lockstep.test.ts (textual).
 */

import type { Translate } from '@/features/flow-editor/model';

export function welcomeSuggestions(triggerKind: string | null | undefined, t: Translate): string[] {
    const first =
        triggerKind === 'schedule'
            ? t('mobile.flow.ai.suggest_schedule', 'Summarise the latest activity and email me a digest')
            : triggerKind === 'app_event'
                ? t('mobile.flow.ai.suggest_app_event', 'Filter these items, then draft a reply for each')
                : triggerKind === 'webhook'
                    ? t('mobile.flow.ai.suggest_webhook', 'Validate the incoming payload, then post it to Slack')
                    : t('mobile.flow.ai.suggest_default', 'Search my inbox and summarise the results');
    return [
        first,
        t('mobile.flow.ai.suggest_loop', 'Loop over the results and label each one'),
        t('mobile.flow.ai.suggest_notify', 'Add a notification at the end of the flow'),
    ];
}
