/**
 * "Hand over to a colleague", folded under an item's trail (./CoworkDetail.tsx). The colleague gets a new, paused item
 * with the plan to approve; this one goes, with its history, which stays the owner's own.
 */
import { useState } from 'react';
import { UserRoundPlus } from 'lucide-react';
import { useCoworkColleagues, useCoworkHandOver } from '../../api/coworkHandOver';
import { useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';

export default function CoworkHandOver({ coworkId }: { coworkId: string }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [to, setTo] = useState('');
    const colleagues = useCoworkColleagues(coworkId, open);
    const handOver = useCoworkHandOver(coworkId);
    const list = colleagues.data ?? [];
    return (
        <details className="rounded-[10px] border px-[18px] py-3 [border-color:var(--border-subtle)]" data-testid="cowork-hand-over" onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary className="cursor-pointer inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-secondary)]">
                <UserRoundPlus aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork.hand_over.heading', 'Hand over to a colleague')}
            </summary>
            <div className="pt-2 flex flex-col gap-2">
                <p className="text-[12px] text-[var(--text-secondary)]">
                    {t('cowork.hand_over.hint', 'Your colleague gets this work paused, with its plan to approve. Its history stays yours and goes with this item.')}
                </p>
                {colleagues.data && list.length === 0 && <p className="text-[12px] text-[var(--text-tertiary)]">{t('cowork.hand_over.nobody', 'There is nobody in your organisation to hand it to.')}</p>}
                {list.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                        <label htmlFor={`cowork-hand-over-${coworkId}`} className="sr-only">{t('cowork.hand_over.to', 'Colleague')}</label>
                        <select id={`cowork-hand-over-${coworkId}`} className="rounded-lg border px-2 py-1.5 text-[12.5px] bg-[var(--bg-primary)] [border-color:var(--border-default)]" value={to} onChange={(e) => setTo(e.target.value)}>
                            <option value="">{t('cowork.hand_over.choose', 'Choose a colleague')}</option>
                            {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <button type="button" className="px-3 py-1.5 rounded-lg border text-[12px] font-medium [border-color:var(--border-default)] disabled:opacity-50" disabled={!to || handOver.isPending} onClick={() => handOver.mutate(to)}>
                            {t('cowork.hand_over.go', 'Hand over')}
                        </button>
                    </div>
                )}
                {handOver.error && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{errorMessage(handOver.error) || t('cowork_plan.failed', 'That did not work. Try again.')}</p>}
            </div>
        </details>
    );
}
