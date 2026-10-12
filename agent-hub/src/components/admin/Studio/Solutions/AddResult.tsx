import React from 'react';
import Notice from './Notice';
import type { AddOutcome } from './useAddFiling';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * What the last "Add" did: what was added, what came along with it and why,
 * and what was refused, each in the server's own words.
 */
export default function AddResult({ outcome }: { outcome: AddOutcome }) {
    const { t } = useTranslation();
    const { added, cameAlong, failures, total } = outcome;
    const done = added.length + cameAlong.length;
    return (
        <div className="space-y-2">
            {done > 0 && (
                <Notice tone="success" testId="add-parts-result">
                    <p className="font-medium">
                        {t('solutions.add_result_added', 'Added: {names}', { names: added.map(a => a.label).join(', ') || '–' })}
                    </p>
                    {cameAlong.length > 0 && (
                        <div className="mt-1 text-[12px]" data-testid="add-parts-came-along">
                            <p className="text-[var(--text-secondary)]">{t('solutions.add_result_along', 'Came along:')}</p>
                            <ul className="list-disc pl-5">
                                {cameAlong.map(c => <li key={c.key}>{t('solutions.add_result_along_item', '{name} ({why})', { name: c.label, why: c.why })}</li>)}
                            </ul>
                        </div>
                    )}
                </Notice>
            )}
            {failures.length > 0 && (
                <Notice tone="error" testId="solution-add-error">
                    <p className="font-medium">{t('solutions.add_partial', 'Added {done} of {total}. These could not be added:', { done, total })}</p>
                    <ul className="list-disc pl-5 text-[12px]">
                        {failures.map(f => <li key={f.key}>{t('solutions.add_item_failed', '{name}: {reason}', { name: f.label, reason: f.reason })}</li>)}
                    </ul>
                </Notice>
            )}
        </div>
    );
}
