/**
 * The coworks of a desk in the order work moves along them, each with its owner and its last status, never what
 * another owner's runs read or produced (server/usecases/coworkDesks.mts). Shown in an item's Settings tab
 * (./CoworkDeskPanel.tsx) and on the Cowork home (./CoworkDesks.tsx).
 */
import { ArrowDown } from 'lucide-react';
import { runStatusToken } from './coworkStatus';
import { useTranslation } from '@/hooks/useTranslation';
import type { DeskMember } from '@/api/coworkDesks';

export default function CoworkDeskChain({ members, onOpen }: { members: DeskMember[]; onOpen?: (itemId: string) => void }) {
    const { t } = useTranslation();
    if (members.length === 0) return <p className="text-[12px] text-[var(--text-tertiary)]">{t('cowork_desks.empty', 'No coworks on this desk yet.')}</p>;
    return (
        <ol className="flex flex-col" data-testid="cowork-desk-chain">
            {members.map((m, i) => {
                const token = runStatusToken(m.lastStatus);
                const title = m.title || t('cowork_needs.untitled', 'Untitled work');
                return (
                    <li key={m.scheduleId} className="flex flex-col text-[12px]" data-testid="cowork-desk-member">
                        {i > 0 && m.after && <ArrowDown aria-hidden="true" className="w-3 h-3 my-0.5 text-[var(--text-tertiary)]" />}
                        <div className="flex items-baseline gap-2">
                            {m.mine && onOpen
                                ? <button type="button" className="flex-1 min-w-0 truncate text-left underline underline-offset-2 text-[var(--text-primary)]" onClick={() => onOpen(m.scheduleId)}>{title}</button>
                                : <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]">{title}</span>}
                            <span className="text-[var(--text-tertiary)]">
                                {m.mine ? t('cowork_desks.yours', 'yours') : t('cowork_desks.owner', "{owner}'s", { owner: m.ownerName })}
                                {!m.accepted && ` · ${t('cowork_desks.invited', 'invited')}`}
                                {m.lastStatus && ` · ${t(token.labelKey, token.labelEn)}`}
                            </span>
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}
