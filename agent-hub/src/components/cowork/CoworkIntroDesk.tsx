import { ArrowDown, Check, Clock, UserRound, Users } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { SWAP } from './coworkMotion';

/** The same two tasks stay in place while the invitation becomes an active hand-off: only the status line changes. */
export default function CoworkIntroDesk({connected}: {connected: boolean}) {
    const {t} = useTranslation();
    return <div className="cowork-intro-sample cowork-intro-desk" data-connected={connected}>
        <strong><Users aria-hidden size={16}/>{t('cowork_home.story.desk_name', 'Team desk · Monday pilot meeting')}</strong>
        <div><UserRound aria-hidden size={16}/>{t('cowork_home.story.desk_first', 'You · Weekly digest')}</div>
        <ArrowDown aria-hidden size={16}/>
        <div><UserRound aria-hidden size={16}/>{t('cowork_home.story.desk_second', 'Noor · Prepare the team agenda')}</div>
        {connected
            ? <small key="connected" className={SWAP}><Check aria-hidden size={14}/>{t('cowork_home.story.desk_connected', 'Accepted · Starts after the weekly digest')}</small>
            : <small key="invited" className={SWAP}><Clock aria-hidden size={14}/>{t('cowork_home.story.desk_pending', 'Waiting for Noor to accept')}</small>}
    </div>;
}
