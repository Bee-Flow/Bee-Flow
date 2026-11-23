/**
 * "Changes": the trail of an item, under its Settings tab (./CoworkSettings.tsx), read once that tab is shown. Who
 * changed what and when; the text of the work itself is never in it (server/usecases/coworkAudit.mts).
 */
import { useCoworkTrail } from '../../api/coworkTrail';
import { fullTimestamp } from './coworkFormat';
import { trailLine } from './coworkTrailModel';
import { useTranslation } from '../../hooks/useTranslation';

export default function CoworkTrail({ coworkId }: { coworkId: string }) {
    const { t } = useTranslation();
    const trail = useCoworkTrail(coworkId, true);
    return (
        <div data-testid="cowork-trail">
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
    );
}
