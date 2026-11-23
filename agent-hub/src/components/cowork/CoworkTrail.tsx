/**
 * "Changes to this work": the trail of an item, folded until opened. Who changed what and when; the text of the work
 * itself is never in it (server/usecases/coworkAudit.mts).
 */
import { useState } from 'react';
import { History } from 'lucide-react';
import { useCoworkTrail } from '../../api/coworkTrail';
import { fullTimestamp } from './coworkFormat';
import { trailLine } from './coworkTrailModel';
import { useTranslation } from '../../hooks/useTranslation';

export default function CoworkTrail({ coworkId }: { coworkId: string }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const trail = useCoworkTrail(coworkId, open);
    return (
        <details className="rounded-[10px] border px-[18px] py-3 [border-color:var(--border-subtle)]" data-testid="cowork-trail" onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary className="cursor-pointer inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-secondary)]">
                <History aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork_trail.heading', 'Changes to this work')}
            </summary>
            <div className="pt-2">
                {trail.isError && <p className="text-[12px] text-[var(--text-tertiary)]">{t('cowork_trail.failed', 'The changes could not be loaded.')}</p>}
                {trail.data && trail.data.length === 0 && <p className="text-[12px] text-[var(--text-tertiary)]">{t('cowork_trail.empty', 'No changes recorded yet.')}</p>}
                {trail.data && trail.data.length > 0 && (
                    <ol className="flex flex-col gap-1">
                        {trail.data.map((entry, i) => (
                            <li key={`${entry.action}-${entry.at ?? i}-${i}`} className="flex gap-3 text-[12px]" data-testid="cowork-trail-entry">
                                <span className="w-[120px] flex-shrink-0 tabular-nums text-[var(--text-tertiary)]">{entry.at ? fullTimestamp(entry.at, t) : ''}</span>
                                <span className="text-[var(--text-secondary)]">{trailLine(entry, t)}</span>
                            </li>
                        ))}
                    </ol>
                )}
            </div>
        </details>
    );
}
