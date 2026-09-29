import { Undo2, Wand2 } from 'lucide-react';
import React from 'react';

import Button from '../../../../../../shared/Button';
import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { falseAlarmsLine, tuneDescribeLine } from '../ownDataCopy';
import type { TuneInfo } from '../useTypeWizard';

/**
 * What "Tune automatically" did, in two lines, with Undo. The before and
 * after numbers are the server's, measured on the same sentences, so the
 * admin can see the gain was real rather than take it on trust.
 */
export function TuneResult({ info, canUndo, onUndo, t }: { info: TuneInfo; canUndo: boolean; onUndo: () => void; t: TranslateFn }) {
    if (!info.improved) {
        return (
            <p role="status" className="m-0 text-xs text-[var(--text-secondary)]">
                {t('shield_data.tune_no_gain', 'Tuning found nothing better. Your current settings are the best we tried.')}
            </p>
        );
    }
    return (
        <div role="status" className="flex items-start gap-2 rounded-lg px-3 py-2 border border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_8%,transparent)]">
            <Wand2 className="w-4 h-4 shrink-0 mt-0.5 text-[var(--success-ink)]" aria-hidden="true" />
            <div className="min-w-0 flex-1 text-xs text-[var(--text-primary)]">
                <p className="m-0">
                    {t('shield_data.tuned_summary', 'Tuned. Now finds {found} of {total} (was {wasFound}) with {alarms} (was {wasAlarms}).', {
                        found: info.after.found,
                        total: info.after.total,
                        wasFound: info.before.found,
                        alarms: falseAlarmsLine(info.after.falseAlarms, t),
                        wasAlarms: info.before.falseAlarms,
                    })}
                </p>
                <p className="m-0 mt-0.5 text-[var(--text-secondary)]">{tuneDescribeLine(info, t)}</p>
            </div>
            {canUndo && <Button size="sm" variant="ghost" icon={Undo2} onClick={onUndo}>{t('shield_data.tune_undo', 'Undo')}</Button>}
        </div>
    );
}

export default TuneResult;
