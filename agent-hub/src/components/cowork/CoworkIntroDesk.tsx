import { ArrowDown, Check, Clock, UserRound, Users } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';

/** The same two tasks stay in place as the invitation becomes an active hand-off. */
export default function CoworkIntroDesk({scene}: {scene: 'desk' | 'invite' | 'handoff' | 'cover'}) {
    const {t} = useTranslation();
    const connected = scene === 'handoff' || scene === 'cover';
    return <div className="cowork-intro-sample cowork-intro-desk">
        <strong><Users size={16}/>{t('cowork_home.story.desk_name', 'Team desk · Monday pilot meeting')}</strong>
        <div><UserRound size={16}/>{t('cowork_home.story.desk_first', 'You · Weekly digest')}</div>
        <ArrowDown aria-hidden size={16}/>
        <div><UserRound size={16}/>{t('cowork_home.story.desk_second', 'Noor · Prepare the team agenda')}</div>
        {scene === 'invite' && <small><Clock size={14}/>{t('cowork_home.story.desk_pending', 'Waiting for Noor to accept')}</small>}
        {connected && <small><Check size={14}/>{t('cowork_home.story.desk_connected', 'Accepted · Starts after the weekly digest')}</small>}
        {scene === 'cover' && <small>{t('cowork_home.story.desk_backup', 'Pilot questions · Noor, with Alex as stand-in')}</small>}
    </div>;
}
