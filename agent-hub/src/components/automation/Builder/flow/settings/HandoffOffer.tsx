import { singularKey } from '@shared/expr/rules.mjs';
import { Plus } from 'lucide-react';
import { rowInputClass } from './formPrimitives';
import { PRIMARY_BUTTON_CLASS, useRuleLine } from './RouteAssistParts';
import { useTranslation } from '@/hooks/useTranslation';
import type { HandoffOfferProps, HandoffPlanPreviewProps } from './RouteAssist.types';

export function HandoffOffer({
    offered = false, answers, onAnswers, named = [], plan, perItem, unit,
    existingRuleCount = 0, losingWires = [], onAccept,
}: HandoffOfferProps) {
    const { t } = useTranslation();
    if (!offered) return null;
    return (
        <div className="space-y-1.5 rounded border border-[var(--border-default)] p-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
                <Plus size={12} /> {t('automations.route_assist.have_an_ai_step_answer_it', 'Have an AI step answer it first')}
            </div>
            <div className="text-[10px] text-[var(--text-tertiary)]">
                {t('automations.route_assist.an_output_can_only_compare_fields', 'An output can only compare fields that already exist, and none of the fields here holds the answer to that question. An AI step placed before this one can answer it in a single word, and the outputs then check that word. This ADDS A STEP to your automation — it is the only thing in this box that does.')}
            </div>
            <input
                type="text"
                value={answers}
                onChange={(e) => onAnswers(e.target.value)}
                aria-label={t('automations.route_assist.name_the_possible_answers', 'Name the possible answers')}
                placeholder={t('automations.route_assist.complaint_question_something_else', 'complaint, question, something else')}
                className={rowInputClass('w-full')}
            />
            {/* A plan this cannot make says why, in a sentence. A greyed-out
                button with no reason attached is the thing an author stares
                at and then rebuilds by hand. */}
            {plan?.problem && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">{plan.problem}</div>
            )}
            {plan?.step && (
                <HandoffPlanPreview
                    plan={plan}
                    named={named}
                    perItem={perItem}
                    unit={unit}
                    existingRuleCount={existingRuleCount}
                    losingWires={losingWires}
                    onAccept={onAccept}
                />
            )}
        </div>
    );
}

function HandoffPlanPreview({ plan, named, perItem, unit, existingRuleCount, losingWires, onAccept }: HandoffPlanPreviewProps) {
    const { t } = useTranslation();
    const ruleLine = useRuleLine();
    const n = plan.rules.length;
    const one = n === 1;
    const oneWire = losingWires.length === 1;
    const introParams = {
        label: plan.step.label,
        item: perItem ? singularKey(unit) : '',
        words: named.length === 1 ? t('automations.route_assist.that_word', 'that word') : t('automations.route_assist.those_words', 'those {count} words', { count: named.length }),
        outputs: one ? t('automations.route_assist.one_output', 'one output') : t('automations.route_assist.n_outputs', '{count} outputs', { count: n }),
    };
    return (
        <div className="space-y-1.5">
            <div className="text-[10px] text-[var(--text-tertiary)]">
                {perItem
                    ? t('automations.route_assist.plan_intro_per_item', 'One new step, “{label}”, run once per {item} of the list above, answering with one of {words}, and {outputs} here reading it:', introParams)
                    : t('automations.route_assist.plan_intro', 'One new step, “{label}”, answering with one of {words}, and {outputs} here reading it:', introParams)}
            </div>
            <ul className="space-y-1">
                {plan.rules.map(r => (
                    <li key={r.name} className="text-[11px] text-[var(--text-secondary)]">
                        <span className="text-[var(--text-primary)] font-medium">{r.name}</span>
                        {' — '}
                        {ruleLine(r.expr)}
                    </li>
                ))}
            </ul>
            {/* The match count that is deliberately absent. Every other preview
                in this box counts against the sample rows the editor already
                has; here the field being compared does not exist yet in any of
                them, so there is nothing to count and "0 of 12 matched" would
                read as a broken rule rather than an unanswered question. */}
            <div className="text-[10px] text-[var(--text-tertiary)]">
                {t('automations.route_assist.nothing_to_count', 'Nothing can be counted against the sample {unit} yet. The answer is written by the new step, so it exists only once this has run.', { unit })}
            </div>
            {named.length > n && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">
                    {t('automations.route_assist.only_first_used', 'Only the first {count} answers are used. More outputs than that is a lookup table rather than a routing decision, and every one of them is a port someone has to wire.', { count: n })}
                </div>
            )}
            {existingRuleCount > 0 && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">
                    {existingRuleCount === 1
                        ? t('automations.route_assist.accept_replaces_one', 'Accepting replaces the output already set up below.')
                        : t('automations.route_assist.accept_replaces_many', 'Accepting replaces the {count} outputs already set up below.', { count: existingRuleCount })}
                </div>
            )}
            {losingWires.length > 0 && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">
                    {oneWire
                        ? t('automations.route_assist.plan_wire_lost_one', '{names} is wired on the canvas and is not in this plan, so its connection goes too.', { names: losingWires.join(', ') })
                        : t('automations.route_assist.plan_wire_lost_many', '{names} are wired on the canvas and are not in this plan, so their connections go too.', { names: losingWires.join(', ') })}
                </div>
            )}
            <button
                type="button"
                onClick={onAccept}
                className={PRIMARY_BUTTON_CLASS}
            >
                {one
                    ? t('automations.route_assist.add_step_use_one', 'Add the step and use this output')
                    : t('automations.route_assist.add_step_use_many', 'Add the step and use these {count} outputs', { count: n })}
            </button>
        </div>
    );
}
