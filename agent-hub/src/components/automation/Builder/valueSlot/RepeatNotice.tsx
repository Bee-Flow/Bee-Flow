// The one read-only sentence at the head of a step that runs once per item:
// "Runs separately for each item in Order lines from Get orders (12×)",
// with a link to the setting itself. Per item is never switched on by a
// pick, so this sentence is how an author reading the step finds out that
// it is on, and where to change it (StepRepeatSection, under Advanced).

import { Repeat } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useVariablePickerContext } from '../mapping/VariablePickerContext';
import { forEachOf, legacySource, listLabel, repeatCount, repeatOf } from '../flow/settings/advanced/stepRepeat';
import type { Draft } from '../flow/settings/advanced/stepRepeat';

interface Props {
    /** The step as it is on screen (the settings draft). */
    draft: Draft;
    /** Open the step's Advanced section at the setting. */
    onShow?: (() => void) | null;
}

export default function RepeatNotice({ draft, onShow = null }: Props) {
    const { t } = useTranslation();
    const { previewSample, stepLabelById } = useVariablePickerContext() as { previewSample: unknown; stepLabelById: Map<string, string> };
    const repeat = repeatOf(draft);
    const forEach = forEachOf(draft);
    if (!repeat && !forEach) return null;
    const over = repeat ? repeat.over : legacySource(forEach?.overRef);
    const list = listLabel(over, stepLabelById, t);
    const count = repeatCount(draft, previewSample);
    return (
        <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-[var(--text-secondary)]" role="note" data-testid="repeat-notice">
            <Repeat size={13} className="shrink-0 mt-[3px] text-[var(--accent)]" aria-hidden="true" />
            <span>
                {count != null
                    ? t('mapping.repeat.notice', 'Runs separately for each item in {list} ({count}×).', { list, count })
                    : t('mapping.repeat.notice_no_count', 'Runs separately for each item in {list}.', { list })}
                {onShow && (
                    <>
                        {' '}
                        <button type="button" onClick={onShow} className="text-[var(--accent)] hover:underline">
                            {t('mapping.repeat.notice_change', 'Change')}
                        </button>
                    </>
                )}
            </span>
        </p>
    );
}
