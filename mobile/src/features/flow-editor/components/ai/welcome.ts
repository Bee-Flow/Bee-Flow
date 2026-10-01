/**
 * What the assistant offers before the first message — the web's
 * AssistantWelcome.jsx: up to four suggestions that FILL the composer (never
 * send), fitting what the routine already is. A selected step comes first
 * (the phone has no selection, so it passes none); a flow with steps gets
 * ways to extend it; an empty one gets a start that fits its trigger, or
 * three general ones. Same keys as the web. Pinned by ai.lockstep.test.ts.
 */

import type { Translate } from '@/features/flow-editor/model';

export interface WelcomeContext {
    /** How many steps the flow has. */
    steps: number;
    /** The selected step, when the surface has a selection. */
    selectedStep?: { type: string } | null;
}

export function welcomeSuggestions(triggerKind: string | null | undefined, t: Translate, context: WelcomeContext = { steps: 0 }): string[] {
    const { steps, selectedStep = null } = context;
    const chips: string[] = [];
    const suggest = (key: string, fallback: string) => chips.push(t(`routines.assistant.suggest.${key}`, fallback));
    if (selectedStep?.type === 'code') suggest('code', 'Write the code for the selected step');
    if (selectedStep?.type === 'ai_step') suggest('prompt', 'Improve the instruction for this AI step');
    if (selectedStep && steps) suggest('mapping', 'Check the field mappings of this step');
    if (steps) {
        suggest('loop', 'Process each item with AI');
        suggest('filter', 'Only let through the items that match my conditions');
        suggest('notify', 'Send me a message when the flow finishes');
    } else if (triggerKind === 'schedule') suggest('digest', 'Summarise the latest activity and email me a digest');
    else if (triggerKind === 'app_event') suggest('event', 'Filter these items, then draft a reply for each');
    else if (triggerKind === 'webhook') suggest('webhook', 'Validate the incoming data and send me a notification');
    else {
        suggest('invoices', 'Read invoices from my inbox and save them in a table');
        suggest('summary', 'Summarise a document with AI');
        suggest('approval', 'Ask someone to approve a request');
    }
    return chips.slice(0, 4);
}
