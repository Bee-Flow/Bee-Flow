/**
 * What the assistant offers before the first message — the web's
 * chat/AssistantWelcome.tsx (`welcomeIdeas`) and chat/exampleBriefs.ts. Each
 * offer is a whole message: a tap SENDS it. A draft nobody has built in yet
 * (the web's emptyDraft.ts) gets three example briefs; any other flow gets at
 * most three ideas read off the automation itself: the selected step first
 * (the phone has no selection, so it passes none), then what the flow does
 * not do yet. Same keys as the web. Pinned by ai.lockstep.test.ts.
 */

import type { Translate } from '@/features/flow-editor/model';

/** The parts of a step the ideas read. */
export interface WelcomeStep {
    type?: string;
    tool?: unknown;
}

/** The parts of a definition the welcome reads. */
export interface WelcomeDefinition {
    trigger?: { kind?: unknown } | null;
    triggers?: unknown;
    steps?: readonly WelcomeStep[] | null;
}

/**
 * A draft nobody has built anything in yet: no steps, no extra entry points,
 * and at most the manual start a new automation is created with.
 */
export function isEmptyDraft(def: WelcomeDefinition | null | undefined): boolean {
    if (!def || typeof def !== 'object') return true;
    if (Array.isArray(def.steps) && def.steps.length > 0) return false;
    if (Array.isArray(def.triggers) && def.triggers.length > 0) return false;
    const kind = def.trigger?.kind;
    return !def.trigger || !kind || kind === 'manual';
}

/** Three briefs a person could have written themselves, in their own words. */
export function exampleBriefs(t: Translate): string[] {
    return [
        t('automations.assistant.brief.contact_form', 'When someone fills in the contact form, save the answers in a table and email me a short summary'),
        t('automations.assistant.brief.weekly_digest', 'Every Monday at 9:00, summarise last week\'s new rows in a table and email the summary to the team'),
        t('automations.assistant.brief.invoice_approval', 'When an invoice arrives by email, read the amount and the due date and ask a colleague to approve it'),
    ];
}

/** A step that tells somebody something: a notification, or an app action that sends or posts. */
function notifies(step: WelcomeStep): boolean {
    if (step.type === 'notification') return true;
    const tool = typeof step.tool === 'string' ? step.tool.toLowerCase() : '';
    return /send|mail|post_message|notify/.test(tool);
}

type Add = (key: string, fallback: string) => void;

/** What a flow with steps does not do yet. */
function extendIdeas(steps: readonly WelcomeStep[], kind: unknown, add: Add): void {
    const types = new Set(steps.map((s) => s.type));
    add('explain', 'Explain what this automation does, step by step');
    if (kind === 'form' && !types.has('datatable')) add('save_answers', 'Save each answer in a table');
    if (!steps.some(notifies)) add('notify', 'Send me a message when the flow finishes');
    if (!types.has('condition') && !types.has('switch')) add('filter', 'Only let through the items that match my conditions');
}

/** A start that fits the trigger of a flow without steps. */
function startIdeas(kind: unknown, add: Add): void {
    if (kind === 'form') {
        add('save_answers', 'Save each answer in a table');
        add('email_answers', 'Email me each new answer');
        add('approval', 'Ask someone to approve a request');
    } else if (kind === 'schedule') add('digest', 'Summarise the latest activity and email me a digest');
    else if (kind === 'app_event') add('event', 'Filter these items, then draft a reply for each');
    else if (kind === 'webhook') add('webhook', 'Validate the incoming data and send me a notification');
}

/** At most three things worth asking next, read off the automation itself. */
export function welcomeSuggestions(definition: WelcomeDefinition | null | undefined, t: Translate, selectedStep: WelcomeStep | null = null): string[] {
    const steps = definition?.steps || [];
    const kind = definition?.trigger?.kind || '';
    const ideas: string[] = [];
    const add: Add = (key, fallback) => ideas.push(t(`automations.assistant.suggest.${key}`, fallback));
    if (selectedStep?.type === 'code') add('code', 'Write the code for the selected step');
    if (selectedStep?.type === 'ai_step') add('prompt', 'Improve the instruction for this AI step');
    if (selectedStep && steps.length) add('uses', 'Check what this step uses from the earlier steps');
    if (steps.length) extendIdeas(steps, kind, add);
    else startIdeas(kind, add);
    return [...new Set(ideas)].slice(0, 3);
}

/** What the welcome offers: the example briefs on an empty draft, the ideas otherwise. */
export function welcomeOffers(definition: WelcomeDefinition | null | undefined, t: Translate): string[] {
    return isEmptyDraft(definition) ? exampleBriefs(t) : welcomeSuggestions(definition, t);
}
