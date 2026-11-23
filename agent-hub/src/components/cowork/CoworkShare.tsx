/**
 * "Share with your team", folded in an item (./CoworkDetail.tsx): colleagues of the owner's organisation who may see
 * it, and at most one who also decides its runs' questions. The item stays the owner's: it runs as them, and only
 * they change it.
 */
import { useState } from 'react';
import { Users } from 'lucide-react';
import { useCoworkColleagues } from '../../api/coworkHandOver';
import { useCoworkShares, type Share, type ShareRole } from '../../api/coworkShares';
import { useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';

const FIELD = 'rounded-lg border px-2 py-1 text-[12px] bg-[var(--bg-primary)] [border-color:var(--border-default)]';

export default function CoworkShare({ coworkId }: { coworkId: string }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const colleagues = useCoworkColleagues(coworkId, open).data ?? [];
    const { query, save } = useCoworkShares(coworkId, open);
    // What the owner changed since the last save, on top of what is saved.
    const [edits, setEdits] = useState<Record<string, ShareRole | ''>>({});
    const draft: Record<string, ShareRole | ''> = { ...Object.fromEntries((query.data ?? []).map((s) => [s.userId, s.role])), ...edits };
    const deciders = Object.values(draft).filter((r) => r === 'approver').length;
    const shares: Share[] = Object.entries(draft).filter(([, role]) => role).map(([userId, role]) => ({ userId, role: role as ShareRole }));
    return (
        <details className="rounded-[10px] border px-[18px] py-3 [border-color:var(--border-subtle)]" data-testid="cowork-share" onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary className="cursor-pointer inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-secondary)]">
                <Users aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork.share.heading', 'Share with your team')}
            </summary>
            <div className="pt-2 flex flex-col gap-2">
                <p className="text-[12px] text-[var(--text-secondary)]">
                    {t('cowork.share.hint', 'Colleagues can see this work and its runs; one of them can decide its questions. It keeps running as you, and only you change it.')}
                </p>
                <ul className="flex flex-col gap-1">
                    {colleagues.map((c) => (
                        <li key={c.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                            <span className="text-[var(--text-primary)]">{c.name}</span>
                            <select aria-label={t('cowork.share.role_for', 'What {name} may do', { name: c.name })} className={FIELD} value={draft[c.id] ?? ''} onChange={(e) => setEdits((d) => ({ ...d, [c.id]: e.target.value as ShareRole | '' }))}>
                                <option value="">{t('cowork.share.none', 'Not shared')}</option>
                                <option value="viewer">{t('cowork.share.viewer', 'Can see it')}</option>
                                <option value="approver">{t('cowork.share.approver', 'Sees it and decides its questions')}</option>
                            </select>
                        </li>
                    ))}
                </ul>
                {deciders > 1 && <p role="alert" className="text-[12px] text-[var(--warning-ink)]">{t('cowork.share.one_decider', 'One colleague decides the questions; choose one.')}</p>}
                <div>
                    <button type="button" className="px-3 py-1.5 rounded-lg border text-[12px] font-medium [border-color:var(--border-default)] disabled:opacity-50" disabled={deciders > 1 || save.isPending} onClick={() => save.mutate(shares, { onSuccess: () => setEdits({}) })}>
                        {t('cowork.share.save', 'Save who it is shared with')}
                    </button>
                </div>
                {save.error && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{errorMessage(save.error) || t('cowork_plan.failed', 'That did not work. Try again.')}</p>}
            </div>
        </details>
    );
}
