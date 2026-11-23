/**
 * "Shared with you", on the Cowork home (./CoworkHome.tsx): the coworks colleagues shared with the reader, each opened
 * read only, with its brief and its last runs. Deciding a question happens under Approvals, like any other.
 */
import { useState } from 'react';
import { Users } from 'lucide-react';
import { useSharedItem, useSharedWithMe } from '../../api/coworkShares';
import { useTranslation } from '../../hooks/useTranslation';
import type { TranslateFn } from '../../hooks/useTranslation';

function SharedView({ id, t }: { id: string; t: TranslateFn }) {
    const view = useSharedItem(id).data;
    if (!view) return null;
    return (
        <div className="pl-3 pt-1 flex flex-col gap-1" data-testid="cowork-shared-view">
            <p className="text-[12px] text-[var(--text-secondary)] whitespace-pre-wrap">{view.item.prompt}</p>
            <ul className="flex flex-col gap-0.5">
                {view.runs.map((r) => (
                    <li key={r.id} className="text-[12px] text-[var(--text-tertiary)]">
                        <span className="tabular-nums">{r.startedAt ? new Date(r.startedAt).toLocaleString() : ''}</span>
                        {' · '}{r.status ?? ''}{r.result ? ` · ${r.result.slice(0, 160)}` : ''}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default function CoworkSharedWithMe() {
    const { t } = useTranslation();
    const items = useSharedWithMe().data ?? [];
    const [openId, setOpenId] = useState<string | null>(null);
    if (items.length === 0) return null;
    return (
        <section className="mb-4 px-[18px]" aria-labelledby="cowork-shared-heading" data-testid="cowork-shared">
            <h2 id="cowork-shared-heading" className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--text-primary)] mb-1">
                <Users aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork.shared.heading', 'Shared with you')}
            </h2>
            <ul className="flex flex-col">
                {items.map((item) => (
                    <li key={item.id}>
                        <button type="button" className="w-full flex items-baseline gap-2 py-1 text-left text-[12px]" aria-expanded={openId === item.id} onClick={() => setOpenId((o) => (o === item.id ? null : item.id))}>
                            <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">{item.title || t('cowork_needs.untitled', 'Untitled work')}</span>
                            <span className="text-[var(--text-tertiary)]">
                                {item.role === 'approver'
                                    ? t('cowork.shared.decides', "{owner}'s, you decide its questions", { owner: item.ownerName })
                                    : t('cowork.shared.sees', "{owner}'s, you can see it", { owner: item.ownerName })}
                            </span>
                        </button>
                        {openId === item.id && <SharedView id={item.id} t={t} />}
                    </li>
                ))}
            </ul>
        </section>
    );
}
