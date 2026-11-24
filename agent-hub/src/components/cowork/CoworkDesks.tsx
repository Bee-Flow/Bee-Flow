/**
 * "Desks", on the Cowork home (./CoworkHome.tsx), only when the reader is on one (made it, has a cowork on it or
 * invited to it, holds a role or stands in): each desk opens to its coworks in the order work moves along them, with
 * each owner and last status (./CoworkDeskChain.tsx). A cowork of the reader's own opens; the others are shown only.
 * On no desk, a quiet "Set up teamwork" opens the Teamwork helper (./CoworkTeamworkHelper.tsx).
 */
import { useState } from 'react';
import { Network } from 'lucide-react';
import CoworkDeskChain from './CoworkDeskChain';
import CoworkTeamworkHelper from './CoworkTeamworkHelper';
import { useDeskView, useMyDesks } from '@/api/coworkDesks';
import { useTranslation } from '@/hooks/useTranslation';

function DeskBody({ id, onOpen }: { id: string; onOpen: (itemId: string) => void }) {
    const view = useDeskView(id).data;
    if (!view) return null;
    return <div className="pl-3 pt-1" data-testid="cowork-desk-view"><CoworkDeskChain deskId={view.desk.id} members={view.members} onOpen={onOpen} /></div>;
}

export default function CoworkDesks({ onOpen }: { onOpen: (itemId: string) => void }) {
    const { t } = useTranslation();
    const query = useMyDesks();
    const desks = query.data ?? [];
    const [openId, setOpenId] = useState<string | null>(null);
    const [helper, setHelper] = useState(false);
    if (helper) return <div className="mb-4 px-[18px]"><CoworkTeamworkHelper onClose={() => setHelper(false)} /></div>;
    if (desks.length === 0) {
        if (!query.isSuccess) return null;
        return (
            <div className="mb-4 px-[18px]" data-testid="cowork-desks-setup">
                <button type="button" className="text-[12px] text-[var(--text-tertiary)] underline underline-offset-2" onClick={() => setHelper(true)}>
                    {t('cowork_teamwork.home_link', 'Set up teamwork')}
                </button>
            </div>
        );
    }
    return (
        <section className="mb-4 px-[18px]" aria-labelledby="cowork-desks-heading" data-testid="cowork-desks">
            <h2 id="cowork-desks-heading" className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--text-primary)] mb-1">
                <Network aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork_desks.home.heading', 'Desks')}
            </h2>
            <ul className="flex flex-col">
                {desks.map((desk) => (
                    <li key={desk.id}>
                        <button type="button" className="w-full flex items-baseline gap-2 py-1 text-left text-[12px]" aria-expanded={openId === desk.id} onClick={() => setOpenId((o) => (o === desk.id ? null : desk.id))}>
                            <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">{desk.name}</span>
                            {desk.isOwner && <span className="text-[var(--text-tertiary)]">{t('cowork_desks.home.made_by_you', 'made by you')}</span>}
                        </button>
                        {openId === desk.id && <DeskBody id={desk.id} onOpen={onOpen} />}
                    </li>
                ))}
            </ul>
        </section>
    );
}
