import { useTranslation } from '../../../../../../hooks/useTranslation';
import type { FormRecord } from '../formState/types';
import { FormRow, denseInputClass, hintTextClass } from '../formPrimitives';
import { FOREACH_CONCURRENCY_MAX, canRunItemsInParallel } from './reliabilityModel';

/**
 * "Items at the same time" under a step that runs once per item. The results
 * stay in the order of the list. Offered by an AI step without tools and by
 * data extraction; with tools the items run one after another, because a tool
 * may change something.
 */
export function ConcurrencyField({ draft, set }: { draft: FormRecord; set: (key: string, value: unknown) => void }) {
    const { t } = useTranslation();
    const forEach = draft.forEach;
    if (!forEach) return null;
    const parallel = canRunItemsInParallel(draft);
    const value = forEach.concurrency ?? '';

    const change = (raw: string) => {
        const next = { ...forEach };
        if (raw === '') delete next.concurrency; else next.concurrency = Number(raw);
        set('forEach', next);
    };

    return (
        <FormRow
            label={t('ai_step_checks.concurrency_label', 'Items at the same time')}
            hint={t('ai_step_checks.concurrency_hint', 'How many items are sent to the AI at once. The results stay in the order of the list. The limits of your AI provider still apply: calls that go over them wait their turn. Leave empty to use the platform default.')}
        >
            <input
                type="number"
                min={1}
                max={FOREACH_CONCURRENCY_MAX}
                value={value}
                disabled={!parallel}
                placeholder={t('ai_step_checks.concurrency_default', 'Default')}
                aria-label={t('ai_step_checks.concurrency_label', 'Items at the same time')}
                onChange={(e) => change(e.target.value)}
                className={denseInputClass('w-28')}
            />
            {!parallel && (
                <p className={`${hintTextClass()} mt-1`}>
                    {t('ai_step_checks.concurrency_tools', 'Not available while the step can use tools: the items then run one after another, in order, because a tool may change something.')}
                </p>
            )}
        </FormRow>
    );
}
