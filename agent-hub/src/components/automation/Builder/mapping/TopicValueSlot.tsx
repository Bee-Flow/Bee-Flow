import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { denseInputClass } from '../flow/settings/formStyles';

/**
 * The right-hand side of an "is about" condition row: the topic in plain words
 * and how sure the classifier must be.
 *
 * The topic is always a literal: the runner collects a step's topics before it
 * runs anything (server/shared/expr/topics.mjs), so a value from another step
 * cannot be a topic. Sensitivity is the row's `threshold`: absent means the
 * service's own default (0.75, classify-service/eval/MODEL-DECISIONS.md),
 * which is what most rules want. "Loose" is the eval's recall-leaning
 * threshold. There is no "strict": on the eval corpus it coincided with the
 * default, so a third level would promise a difference nobody measured.
 */

type Binding = { kind?: string; value?: unknown; path?: string } | null | undefined;

export interface TopicRowPatch {
    value?: Binding;
    threshold?: number;
}

interface Props {
    value: Binding;
    threshold?: number | null;
    onChange: (patch: TopicRowPatch) => void;
}

/** The threshold behind "loose"; "normal" writes no threshold at all. */
export const TOPIC_LOOSE_THRESHOLD = 0.15;

type Level = 'loose' | 'normal' | 'custom';

function levelOf(threshold: number | null | undefined): Level {
    if (typeof threshold !== 'number') return 'normal';
    return threshold === TOPIC_LOOSE_THRESHOLD ? 'loose' : 'custom';
}

export default function TopicValueSlot({ value, threshold, onChange }: Props) {
    const { t } = useTranslation();
    const topic = value?.kind === 'literal' && value.value != null ? String(value.value) : '';
    const level = levelOf(threshold);
    const setLevel = (next: string) => {
        if (next === 'loose') onChange({ threshold: TOPIC_LOOSE_THRESHOLD });
        else if (next === 'normal') onChange({ threshold: undefined });
    };
    return (
        <div className="flex items-stretch gap-1 min-w-0">
            <input
                type="text"
                value={topic}
                maxLength={80}
                onChange={(e) => onChange({ value: { kind: 'literal', value: e.target.value } })}
                placeholder={t('automations.builder.topics.placeholder', 'a complaint')}
                aria-label={t('automations.builder.topics.topic_label', 'Topic')}
                className={denseInputClass('w-full min-w-0')}
            />
            <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                aria-label={t('automations.builder.topics.sensitivity', 'How sure it must be')}
                title={t('automations.builder.topics.sensitivity', 'How sure it must be')}
                className={denseInputClass('w-auto shrink-0')}
            >
                <option value="normal">{t('automations.builder.topics.sensitivity_normal', 'Normal')}</option>
                <option value="loose">{t('automations.builder.topics.sensitivity_loose', 'Loose')}</option>
                {level === 'custom' && <option value="custom">{String(threshold)}</option>}
            </select>
        </div>
    );
}
