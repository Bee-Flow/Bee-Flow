import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import React from 'react';

import Button from '../../../../../../shared/Button';
import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { describeProblemLine } from '../ownDataCopy';
import type { CustomDataType } from '../ownDataModel';
import type { Step, WizardCommit, WizardInit } from '../useTypeWizard';
import { commitOf, describeProblems, useTypeWizard } from '../useTypeWizard';
import { Card } from '../ui';
import StepApply from './StepApply';
import StepDescribe from './StepDescribe';
import type { ConfirmFn, WizardContext } from './stepTypes';
import StepTest from './StepTest';

/**
 * New or edit, in three steps: Describe, Test and tune, Where it applies.
 *
 * Inline in the tab, not a modal: the test bench needs the room, and an
 * admin moving between the list and a type should keep their place on the
 * page. The draft lives in the reducer (useTypeWizard) until "Add to the
 * list", so Cancel simply unmounts.
 */

interface TypeWizardProps {
    init: WizardInit;
    ctx: WizardContext;
    confirm: ConfirmFn;
    onCommit: (commit: WizardCommit) => void;
    onCancel: () => void;
    t: TranslateFn;
}

const STEPS: { step: Step; key: string; fallback: string }[] = [
    { step: 0, key: 'shield_data.step_describe', fallback: 'Describe' },
    { step: 1, key: 'shield_data.step_test', fallback: 'Test and tune' },
    { step: 2, key: 'shield_data.step_apply', fallback: 'Where it applies' },
];

function Steps({ current, t }: { current: Step; t: TranslateFn }) {
    return (
        <ol className="flex items-center gap-2 flex-wrap list-none p-0 m-0" aria-label={t('shield_data.steps_label', 'Steps')}>
            {STEPS.map(({ step, key, fallback }) => {
                const active = step === current;
                const done = step < current;
                return (
                    <li
                        key={step}
                        aria-current={active ? 'step' : undefined}
                        className={'inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border '
                            + (active
                                ? 'bg-[var(--text-primary)] text-[rgb(from_var(--bg-card)_r_g_b_/_1)] border-[var(--text-primary)] font-semibold'
                                : 'border-[var(--border-default)] text-[var(--text-secondary)]')}
                    >
                        <span aria-hidden="true">{done ? <Check className="w-3 h-3" /> : step + 1}</span>
                        {t(key, fallback)}
                    </li>
                );
            })}
        </ol>
    );
}

function Footer({
    step, problem, isNew, onCancel, onBack, onNext, onCommit, t,
}: {
    step: Step; problem: string | null; isNew: boolean;
    onCancel: () => void; onBack: () => void; onNext: () => void; onCommit: () => void; t: TranslateFn;
}) {
    return (
        <div className="flex items-center gap-2 flex-wrap px-4 py-3 border-t border-[var(--border-subtle)]">
            <Button variant="ghost" size="sm" onClick={onCancel}>{t('common.cancel', 'Cancel')}</Button>
            {problem && <p role="status" className="m-0 text-[11px] text-[var(--text-tertiary)]">{problem}</p>}
            <span className="ml-auto flex gap-2">
                {step > 0 && <Button variant="secondary" size="sm" icon={ArrowLeft} onClick={onBack}>{t('common.back', 'Back')}</Button>}
                {step < 2 && (
                    <Button size="sm" onClick={onNext} disabled={!!problem} iconRight={<ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />}>
                        {t('common.next', 'Next')}
                    </Button>
                )}
                {step === 2 && (
                    <Button size="sm" variant="success" icon={Check} onClick={onCommit}>
                        {isNew ? t('shield_data.commit_add', 'Add to the list') : t('shield_data.commit_update', 'Update')}
                    </Button>
                )}
            </span>
        </div>
    );
}

export function TypeWizard({ init, ctx, confirm, onCommit, onCancel, t }: TypeWizardProps) {
    const [state, dispatch] = useTypeWizard(init);
    const problems = state.step === 0 ? describeProblems(state, { types: ctx.types, guardDown: ctx.guardDown }) : [];

    const cancel = async () => {
        if (state.touched) {
            const ok = await confirm({
                title: t('shield_data.cancel_title', 'Stop without saving this type?'),
                description: t('shield_data.cancel_desc', 'What you entered here will be lost.'),
                confirmLabel: t('shield_data.cancel_confirm', 'Stop'),
                cancelLabel: t('shield_data.cancel_keep', 'Keep editing'),
                destructive: true,
            });
            if (!ok) return;
        }
        onCancel();
    };

    const title = init.mode === 'new'
        ? t('shield_data.wizard_new', 'New type')
        : t('shield_data.wizard_edit', 'Edit: {name}', { name: init.type.name });

    return (
        <Card className="flex flex-col min-h-0">
            <div className="flex items-center gap-3 flex-wrap px-4 pt-3.5 pb-3 border-b border-[var(--border-subtle)]">
                <h3 className="text-[13px] font-semibold m-0 text-[var(--text-primary)]">{title}</h3>
                <Steps current={state.step} t={t} />
            </div>
            <div className="px-4 py-4">
                {state.step === 0 && <StepDescribe state={state} dispatch={dispatch} ctx={ctx} t={t} />}
                {state.step === 1 && <StepTest state={state} dispatch={dispatch} ctx={ctx} t={t} />}
                {state.step === 2 && <StepApply state={state} dispatch={dispatch} ctx={ctx} t={t} />}
            </div>
            <Footer
                step={state.step}
                problem={problems[0] ? describeProblemLine(problems[0], t) : null}
                isNew={init.mode === 'new'}
                onCancel={cancel}
                onBack={() => dispatch({ type: 'go', step: (state.step - 1) as Step })}
                onNext={() => dispatch({ type: 'go', step: (state.step + 1) as Step })}
                onCommit={() => onCommit(commitOf(state))}
                t={t}
            />
        </Card>
    );
}

export default TypeWizard;
