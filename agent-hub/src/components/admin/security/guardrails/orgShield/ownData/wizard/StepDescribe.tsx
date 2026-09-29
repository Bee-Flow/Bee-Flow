import { Hash, ListChecks, Sparkles } from 'lucide-react';
import React, { useId, useState } from 'react';

import ChoiceCards from '../../../../../../shared/ChoiceCards';
import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { describeProblemLine, placeholderOf, tokenProblemLine } from '../ownDataCopy';
import type { Method } from '../ownDataModel';
import {
    LIMITS, aiTypeCount, suggestTokenKey, tokenKeyProblem,
} from '../ownDataModel';
import { LinkButton } from '../ui';
import { helpClass, inputClass, labelClass } from './fieldStyles';
import MethodInputs from './MethodInputs';
import type { StepProps } from './stepTypes';

/**
 * Step 1: what is it called, what does it look like, and how do we find it.
 *
 * The name also names the placeholder the AI sees (`[project_code_1]`), so
 * the helper under it shows that live. The description is the one field the
 * assistant reads word for word, which is why it warns against real values.
 */

function TokenKeyField({ state, dispatch, ctx, t }: StepProps) {
    const [editing, setEditing] = useState(false);
    const id = useId();
    const problem = tokenKeyProblem(state.type.tokenKey, ctx.types, state.type);
    return (
        <div className="mt-1">
            <p className={helpClass}>
                {t('shield_data.name_helper', 'The AI sees it as {placeholder}.', { placeholder: placeholderOf(state.type.tokenKey) })}{' '}
                {!editing && <LinkButton onClick={() => setEditing(true)}>{t('shield_data.name_change', 'Change')}</LinkButton>}
            </p>
            {editing && (
                <div className="mt-2 max-w-xs">
                    <label htmlFor={id} className={labelClass}>{t('shield_data.token_label', 'Placeholder name')}</label>
                    <input
                        id={id}
                        type="text"
                        value={state.type.tokenKey}
                        maxLength={32}
                        aria-invalid={problem ? 'true' : undefined}
                        onChange={e => dispatch({ type: 'patch', patch: { tokenKey: e.target.value.toLowerCase() } })}
                        className={`${inputClass} font-mono text-xs`}
                    />
                    {problem && <p role="alert" className="text-[11px] mt-1 mb-0 text-[var(--error-ink)]">{tokenProblemLine(problem, t)}</p>}
                </div>
            )}
        </div>
    );
}

function NameField(props: StepProps) {
    const { state, dispatch, ctx, t } = props;
    const id = useId();
    const onName = (name: string) => {
        const cur = state.type;
        // A new type's placeholder follows its name until the admin picks
        // one. An existing type keeps its placeholder: a rename is not a
        // reason to change what the AI has been reading.
        const auto = state.mode === 'new' && (!cur.tokenKey || cur.tokenKey === suggestTokenKey(cur.name, ctx.types, cur));
        dispatch({ type: 'patch', patch: auto ? { name, tokenKey: suggestTokenKey(name, ctx.types, cur) } : { name } });
    };
    return (
        <div>
            <label htmlFor={id} className={labelClass}>{t('shield_data.name_label', 'Name')}</label>
            <input
                id={id}
                type="text"
                value={state.type.name}
                maxLength={LIMITS.name}
                onChange={e => onName(e.target.value)}
                placeholder={t('shield_data.name_placeholder', 'For example: Project code names')}
                className={inputClass}
            />
            <TokenKeyField {...props} />
        </div>
    );
}

function DescriptionField({ state, dispatch, t }: StepProps) {
    const id = useId();
    const helpId = useId();
    return (
        <div>
            <label htmlFor={id} className={labelClass}>{t('shield_data.desc_label', 'Describe it in one sentence')}</label>
            <textarea
                id={id}
                rows={2}
                value={state.type.description}
                maxLength={LIMITS.description}
                aria-describedby={helpId}
                onChange={e => dispatch({ type: 'patch', patch: { description: e.target.value } })}
                className={`${inputClass} resize-y`}
            />
            <p id={helpId} className={helpClass}>
                {t('shield_data.desc_helper', 'Say what it is and what it looks like. Do not put real names or numbers here: the assistant reads this sentence.')}
            </p>
        </div>
    );
}

function methodOptions(aiLock: string | null, t: TranslateFn) {
    return [
        {
            value: 'words' as Method,
            Icon: ListChecks,
            label: t('shield_data.method_words', 'A list of words'),
            description: t('shield_data.method_words_desc', 'For a fixed set of names, like your product or project names. We hide exactly these words.'),
        },
        {
            value: 'pattern' as Method,
            Icon: Hash,
            label: t('shield_data.method_pattern', 'A fixed format'),
            description: t('shield_data.method_pattern_desc', 'For numbers and codes that always look the same, like KL-12345. Give a few examples and we work out the format.'),
        },
        {
            value: 'ai' as Method,
            Icon: Sparkles,
            label: t('shield_data.method_ai', 'Recognised by AI'),
            description: t('shield_data.method_ai_desc', 'For things that vary and cannot be listed, like new project code names. The detection service recognises them from what they are.'),
            disabled: !!aiLock,
            lockedNotice: aiLock || undefined,
        },
    ];
}

export function StepDescribe(props: StepProps) {
    const { state, dispatch, ctx, t } = props;
    const aiFull = aiTypeCount(ctx.types, state.type.id) >= LIMITS.aiTypes;
    let aiLock: string | null = null;
    if (ctx.guardDown) aiLock = describeProblemLine('ai_unavailable', t);
    else if (aiFull) aiLock = describeProblemLine('ai_limit', t);
    return (
        <div className="flex flex-col gap-4 max-w-3xl">
            <NameField {...props} />
            <DescriptionField {...props} />
            <div>
                <p className={labelClass}>{t('shield_data.method_question', 'How should we recognise it?')}</p>
                <ChoiceCards
                    value={state.methodChosen ? state.type.method : null}
                    onChange={method => dispatch({ type: 'set_method', method })}
                    options={methodOptions(aiLock, t)}
                    ariaLabel={t('shield_data.method_question', 'How should we recognise it?')}
                    columns={3}
                />
            </div>
            {state.methodChosen && <MethodInputs {...props} />}
        </div>
    );
}

export default StepDescribe;
