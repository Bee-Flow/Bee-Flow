import { ListChecks, Sparkles } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { exampleBriefs } from './exampleBriefs';
import { isEmptyDraft } from '../emptyDraft';
import type { FlowDefinition, FlowStep } from '../flow/types';

interface AssistantWelcomeProps {
    triggerKind?: string;
    definition?: FlowDefinition | null;
    selectedStep?: FlowStep | null;
    /** Sends the text as the person's own message. */
    onPick?: (text: string) => void;
    /** The current work mode ('describe' | 'discuss' | 'approve' | 'plan' | 'build'). */
    workMode?: string;
    /** Switches the work mode of this automation; absent = the welcome cannot offer it. */
    onWorkModeChange?: ((mode: string) => void) | null;
}

/** How the automation starts, in the words of the sentence "I can see …". */
const SUBJECT_FALLBACK: Readonly<Record<string, string>> = Object.freeze({
    form: 'your form',
    schedule: 'your schedule',
    webhook: 'your webhook',
    app_event: 'the app event it starts from',
    agent_call: 'the agent call it starts from',
    app_trigger: 'the Studio app button it starts from',
    manual: 'a manual start',
});

function formTitle(trigger: FlowStep | null | undefined): string {
    const title = trigger?.form?.title;
    return typeof title === 'string' ? title.trim() : '';
}

/**
 * "I can see your form 'Contact' and the 2 steps after it." What the
 * assistant has in front of it, said the way the person would say it.
 */
export function seenSentence(definition: FlowDefinition | null | undefined, t: TranslateFn): string {
    const trigger = definition?.trigger || null;
    const kind = typeof trigger?.kind === 'string' ? trigger.kind : '';
    const name = kind === 'form' ? formTitle(trigger) : '';
    const subject = name
        ? t('automations.assistant.sees.subject.form_named', 'your form \'{name}\'', { name })
        : kind in SUBJECT_FALLBACK
            ? t(`automations.assistant.sees.subject.${kind}`, SUBJECT_FALLBACK[kind])
            : t('automations.assistant.sees.subject.other', 'how it starts');
    const count = (definition?.steps || []).length;
    if (count === 0) return t('automations.assistant.sees.none', 'I can see {subject}. Nothing happens after it yet.', { subject });
    if (count === 1) return t('automations.assistant.sees.one', 'I can see {subject} and the step after it.', { subject });
    return t('automations.assistant.sees.many', 'I can see {subject} and the {count} steps after it.', { subject, count });
}

/** A step that tells somebody something: a notification, or an app action that sends or posts. */
function notifies(step: FlowStep): boolean {
    if (step.type === 'notification') return true;
    const tool = typeof step.tool === 'string' ? step.tool.toLowerCase() : '';
    return /send|mail|post_message|notify/.test(tool);
}

/**
 * At most three things worth asking next, read off the automation itself:
 * the selected step first, then what the flow does not do yet. Each one is a
 * whole message; a click sends it.
 */
export function welcomeIdeas(definition: FlowDefinition | null | undefined, selectedStep: FlowStep | null | undefined, t: TranslateFn): string[] {
    const steps = definition?.steps || [];
    const kind = definition?.trigger?.kind || '';
    const types = new Set(steps.map((s) => s.type));
    const ideas: string[] = [];
    const add = (key: string, fallback: string) => ideas.push(t(`automations.assistant.suggest.${key}`, fallback));
    if (selectedStep?.type === 'code') add('code', 'Write the code for the selected step');
    if (selectedStep?.type === 'ai_step') add('prompt', 'Improve the instruction for this AI step');
    if (selectedStep && steps.length) add('uses', 'Check what this step uses from the earlier steps');
    if (steps.length) {
        add('explain', 'Explain what this automation does, step by step');
        if (kind === 'form' && !types.has('datatable')) add('save_answers', 'Save each answer in a table');
        if (!steps.some(notifies)) add('notify', 'Send me a message when the flow finishes');
        if (!types.has('condition') && !types.has('switch')) add('filter', 'Only let through the items that match my conditions');
    } else if (kind === 'form') {
        add('save_answers', 'Save each answer in a table');
        add('email_answers', 'Email me each new answer');
        add('approval', 'Ask someone to approve a request');
    } else if (kind === 'schedule') add('digest', 'Summarise the latest activity and email me a digest');
    else if (kind === 'app_event') add('event', 'Filter these items, then draft a reply for each');
    else if (kind === 'webhook') add('webhook', 'Validate the incoming data and send me a notification');
    return [...new Set(ideas)].slice(0, 3);
}

const CHIP_CLASS = 'flex items-center gap-2.5 text-left text-xs p-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--type-ai)] transition';

function IdeaList({ ideas, onPick, testId }: { ideas: string[]; onPick?: (text: string) => void; testId: string }) {
    if (!ideas.length) return null;
    return (
        <div className="flex flex-col gap-2">
            {ideas.map((text) => (
                <button key={text} type="button" data-testid={testId} disabled={!onPick} onClick={() => onPick?.(text)} className={CHIP_CLASS}>
                    <Sparkles size={14} className="shrink-0 text-[var(--text-tertiary)]" /><span>{text}</span>
                </button>
            ))}
        </div>
    );
}

/** The empty draft: what should happen, the offer of "Describe it", and three example briefs. */
function EmptyDraftWelcome({ onPick, workMode, onWorkModeChange }: Pick<AssistantWelcomeProps, 'onPick' | 'workMode' | 'onWorkModeChange'>) {
    const { t } = useTranslation();
    // Both modes ask a few questions before they plan; only 'describe' is offered.
    const planning = workMode === 'describe' || workMode === 'plan';
    return (
        <div className="flex flex-col gap-5 py-5 text-left">
            <div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('automations.assistant.welcome_empty', 'What should happen? Tell me in your own words.')}</h2>
                <p className="text-xs leading-5 mt-1 text-[var(--text-secondary)]">{t('automations.assistant.welcome_empty_hint', 'I build it with you. Pick an example, or describe your own below.')}</p>
            </div>
            {planning && (
                <p role="status" data-testid="assistant-ask-first-on" className="flex items-start gap-2 text-xs leading-5 text-[var(--text-secondary)]">
                    <ListChecks size={14} className="shrink-0 mt-0.5 text-[var(--type-ai)]" />
                    {t('automations.assistant.ask_first_on', 'I will ask a few questions first, then make a plan. Tell me roughly what should happen.')}
                </p>
            )}
            {!planning && onWorkModeChange && (
                <button type="button" data-testid="assistant-ask-first" onClick={() => onWorkModeChange('describe')}
                    className="flex items-start gap-2.5 text-left p-3 rounded-lg border border-[var(--type-ai)] bg-[color-mix(in_srgb,var(--type-ai)_6%,var(--bg-card))] hover:bg-[color-mix(in_srgb,var(--type-ai)_12%,var(--bg-card))] transition">
                    <ListChecks size={15} className="shrink-0 mt-0.5 text-[var(--type-ai)]" />
                    <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
                            {t('automations.assistant.ask_first', 'Describe it')}
                            <span className="rounded px-1.5 py-px text-[10px] font-medium text-[var(--type-ai)] bg-[color-mix(in_srgb,var(--type-ai)_14%,transparent)]">{t('automations.assistant.recommended', 'Recommended')}</span>
                        </span>
                        <span className="block mt-0.5 text-[11px] leading-4 text-[var(--text-tertiary)]">{t('automations.assistant.ask_first_hint', 'I ask a few questions first, then write a plan in plain words and build it after your OK.')}</span>
                    </span>
                </button>
            )}
            <div>
                <div className="text-[11px] font-medium text-[var(--text-tertiary)] mb-2">{t('automations.assistant.examples', 'For example')}</div>
                <IdeaList ideas={exampleBriefs(t)} onPick={onPick} testId="assistant-example-brief" />
            </div>
        </div>
    );
}

export default function AssistantWelcome({ definition = null, selectedStep = null, onPick, workMode, onWorkModeChange = null }: AssistantWelcomeProps) {
    const { t } = useTranslation();
    if (isEmptyDraft(definition) && !selectedStep) {
        return <EmptyDraftWelcome onPick={onPick} workMode={workMode} onWorkModeChange={onWorkModeChange} />;
    }
    const selectedLabel = selectedStep ? (selectedStep.label || selectedStep.type || '') : '';
    return (
        <div className="flex flex-col gap-5 py-5 text-left">
            <div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('automations.assistant.welcome_existing', 'What would you like to change?')}</h2>
                <p data-testid="assistant-seen" className="text-xs leading-5 mt-1 text-[var(--text-secondary)]">
                    {seenSentence(definition, t)}
                    {selectedLabel && <> {t('automations.assistant.sees.selected', 'You have \'{label}\' selected.', { label: selectedLabel })}</>}
                </p>
            </div>
            <IdeaList ideas={welcomeIdeas(definition, selectedStep, t)} onPick={onPick} testId="assistant-idea" />
        </div>
    );
}
