/**
 * The line at the top of a fill-in form that says the one thing to do next
 * (projectFillModel.ts `guideStep`). Whoever opens the form, in the chat, in a
 * project or in the editor, reads the same sentence for the same state. Its
 * tone follows what it says: someone is waiting, something is to be done,
 * everything is done.
 */
import { CheckCircle2, CircleDot, Eye, Sparkles, UserRoundCheck, type LucideIcon } from 'lucide-react';

import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import { nOf } from '@/utils/plural';
import type { GuideStep } from './projectFillModel';

export interface GuideContext {
    /** The document is a project's: colleagues fill it in too. */
    inProject: boolean;
    /** The form sits under an answer of the assistant: it can be told as well. */
    withAssistant: boolean;
}

function missingText(step: Extract<GuideStep, { kind: 'missing' }>, ctx: GuideContext, t: TranslateFn): string {
    const count = nOf(t, 'chat_templates.guide_missing', step.count, '1 required field is still empty.', '{count} required fields are still empty.');
    let waiting = '';
    if (step.waiting > 0 && step.count === 1) waiting = ` ${t('chat_templates.guide_waiting_only', 'A colleague was asked for it.')}`;
    else if (step.waiting > 0) {
        waiting = ` ${nOf(t, 'chat_templates.guide_waiting', step.waiting, '1 of them is asked of a colleague.', '{count} of them are asked of colleagues.')}`;
    }
    let how = nOf(t, 'chat_templates.guide_how_form', step.count, 'Fill it in under “Still needed”.', 'Fill them in under “Still needed”.');
    if (ctx.inProject) {
        how = nOf(t, 'chat_templates.guide_how_project', step.count,
            'Fill it in under “Still needed”, or ask a colleague at the field.', 'Fill them in under “Still needed”, or ask a colleague at the field.');
    } else if (ctx.withAssistant) {
        how = nOf(t, 'chat_templates.guide_how_chat', step.count,
            'Fill it in under “Still needed”, or tell the assistant in the chat.', 'Fill them in under “Still needed”, or tell the assistant in the chat.');
    }
    return `${count}${waiting} ${how}`;
}

function guideText(step: GuideStep, ctx: GuideContext, t: TranslateFn): string {
    switch (step.kind) {
        case 'readOnly': return t('chat_templates.form_read_only', 'You can read this document, but not change it.');
        case 'done': return ctx.inProject
            ? t('chat_templates.guide_done_project', 'Finished. Download it, or put it in a folder of the project.')
            : t('chat_templates.guide_done', 'Finished. Download it, or save it in a project.');
        case 'asked': return nOf(t, 'chat_templates.guide_asked', step.count,
            'A colleague is waiting for 1 field from you. It is at the top, under “Asked of you”.',
            'Colleagues are waiting for {count} fields from you. They are at the top, under “Asked of you”.');
        case 'missing': return missingText(step, ctx, t);
        case 'remarks': return nOf(t, 'chat_templates.guide_remarks', step.count,
            'The check has 1 remark. Look at it at its field, then finish.',
            'The check has {count} remarks. Go through them at their fields, then finish.');
        case 'check': return t('chat_templates.guide_check', 'Everything needed is filled in. Next: let the assistant check it, then finish.');
        default: return step.checked
            ? t('chat_templates.guide_finish', 'Checked, nothing left to do. You can finish it.')
            : t('chat_templates.guide_finish_unchecked', 'Everything needed is filled in. You can finish it.');
    }
}

const ICONS: Record<GuideStep['kind'], LucideIcon> = {
    readOnly: Eye, done: CheckCircle2, asked: UserRoundCheck, missing: CircleDot, remarks: Sparkles, check: Sparkles, finish: CheckCircle2,
};

type Tone = 'quiet' | 'todo' | 'waiting' | 'good';
const TONE_OF: Record<GuideStep['kind'], Tone> = {
    readOnly: 'quiet', done: 'good', asked: 'waiting', missing: 'todo', remarks: 'todo', check: 'todo', finish: 'good',
};
/** The bar at the left and the wash behind the sentence, per tone. */
const TONES: Record<Tone, { box: string; icon: string }> = {
    quiet: { box: 'border-[var(--border-default)] bg-[var(--bg-tertiary)]', icon: 'text-[var(--text-tertiary)]' },
    todo: { box: 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_7%,transparent)]', icon: 'text-[var(--accent-primary)]' },
    waiting: { box: 'border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]', icon: 'text-[var(--warning)]' },
    good: { box: 'border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)]', icon: 'text-[var(--success)]' },
};

/** Which of the three steps the form is at: 0 fill in, 1 check, 2 done. */
export function stageOf(step: GuideStep): number {
    if (step.kind === 'done') return 2;
    return step.kind === 'asked' || step.kind === 'missing' || step.kind === 'readOnly' ? 0 : 1;
}

export default function FillGuide({ step, context }: { step: GuideStep; context: GuideContext }) {
    const { t } = useTranslation();
    const Icon = ICONS[step.kind];
    const tone = TONES[TONE_OF[step.kind]];
    return (
        <p role="status" data-testid="template-fill-guide" data-step={step.kind}
            className={`m-0 flex items-start gap-2 rounded-md border-l-[3px] px-3 py-2 text-[13px] leading-snug text-[var(--text-primary)] ${tone.box}`}>
            <Icon size={15} className={`mt-px shrink-0 ${tone.icon}`} aria-hidden="true" />
            <span>{guideText(step, context, t)}</span>
        </p>
    );
}
