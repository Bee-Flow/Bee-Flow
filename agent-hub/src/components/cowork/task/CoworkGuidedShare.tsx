import { useState } from 'react';
import { namedColleague } from './coworkColleagueSelection';
import { useCoworkColleagues } from '@/api/coworkHandOver';
import { useCoworkShares, type Share, type ShareRole } from '@/api/coworkShares';
import type { TranslateFn } from '@/hooks/useTranslation';
import { BTN_PRIMARY, FIELD, Failure, LABEL, META } from './taskUi';

interface Colleague { id: string; name: string }

type Access = ShareRole | 'remove';
function requestedAccess(message: string): Access | null {
    if (/\b(?:not|niet|geen|no|without|zonder)\b/i.test(message)) return null;
    if (/\b(?:unshare|revoke|stop sharing|intrekken|trek de toegang|stop (?:met )?delen)\b/i.test(message)) return 'remove';
    if (/\b(?:as (?:an? )?approver|als (?:goedkeurder|beoordelaar))\s*[.!]?$/i.test(message)) return 'approver';
    if (/\b(?:as (?:a )?viewer|als (?:lezer|kijker))\s*[.!]?$/i.test(message)) return 'viewer';
    return null;
}

interface FormProps {
    colleagues: Colleague[]; shares: Share[]; request: string; busy: boolean; t: TranslateFn;
    onConfirm: (shares: Share[]) => void;
}

function useShareDraft({colleagues, shares, request, busy, onConfirm}: FormProps) {
    const [who, setWho] = useState(() => namedColleague(colleagues, request));
    const current = shares.find(s => s.userId === who)?.role;
    const approver = shares.find(s => s.role === 'approver' && s.userId !== who);
    const [draft, setDraft] = useState<Access | null>(null);
    const role = draft ?? requestedAccess(request) ?? current ?? 'viewer';
    const selected = colleagues.find(c => c.id === who);
    const revokeMissing = role === 'remove' && !current;
    const replace = role === 'approver' ? approver : undefined;
    const ready = selected && role !== current && !revokeMissing;
    const confirm = () => {
        if (!ready || busy) return;
        const others = shares.filter(s => s.userId !== who).map(s => s.userId === replace?.userId ? {...s, role: 'viewer' as const} : s);
        onConfirm(role === 'remove' ? others : [...others, {userId: who, role}]);
    };
    return {who, setWho, current, setDraft, selected, ready, confirm, revokeMissing, replace, role};
}

function ShareForm(props: FormProps) {
    const {colleagues, t, busy} = props;
    const {who, setWho, current, setDraft, selected, ready, confirm, revokeMissing, replace, role} = useShareDraft(props);
    return <form className="grid gap-3" onSubmit={e => {e.preventDefault(); confirm();}}>
        <label className={LABEL}>{t('cowork_task.share.colleague', 'Colleague')}
            <select className={FIELD} value={who} disabled={busy} onChange={e => {setWho(e.target.value); setDraft(null);}}>
                <option value="">{t('cowork_teamwork.choose_person', 'Choose a colleague')}</option>
                {colleagues.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
        </label>
        {selected && revokeMissing && <p role="status" className={META}>{t('cowork_task.share.no_access', '{name} already has no access to this task.', {name: selected.name})}</p>}
        {selected && !revokeMissing && <>
            <label className={LABEL}>{t('cowork_task.share.what_they_do', 'What {name} can do', {name: selected.name})}
                <select className={FIELD} value={role} disabled={busy} onChange={e => setDraft(e.target.value as Access)}>
                    <option value="viewer">{t('cowork_task.share.can_see', 'Can see')}</option>
                    <option value="approver">{t('cowork_task.share.can_answer', 'Can answer')}</option>
                    {current && <option value="remove">{t('automations.sharing.remove', 'Remove access')}</option>}
                </select>
            </label>
            <p className={META}>{t('cowork_task.share.hint', 'Can see: the task and its results. Can answer: also handles what it asks under Needs you. Only one colleague can answer. Nobody else can edit it.')}</p>
            {replace && <p>{t('cowork_task.share.replace_approver', 'After confirmation, {next} will answer task questions. {previous} will keep view access.', {
                next: selected.name, previous: colleagues.find(c => c.id === replace.userId)?.name ?? replace.name ?? replace.userId,
            })}</p>}
            {ready && <button type="submit" className={BTN_PRIMARY + ' justify-self-start'} disabled={busy}>{role === 'remove'
                ? t('automations.sharing.remove', 'Remove access') : t('cowork_task.share.apply', 'Confirm access')}</button>}
        </>}
    </form>;
}

export default function CoworkGuidedShare({coworkId, request, onSaved, t}: {coworkId: string; request: string; onSaved?: () => void; t: TranslateFn}) {
    const people = useCoworkColleagues(coworkId, true);
    const {query, save} = useCoworkShares(coworkId, true);
    if (people.error || query.error) return <Failure error={people.error ?? query.error} t={t} />;
    if (!people.data || !query.data) return <p role="status" className={META}>{t('cowork_pages.loading', 'Loading…')}</p>;
    if (!people.data.length) return <p className={META}>{t('cowork_task.share.nobody', 'There is nobody in your organisation to share it with yet.')}</p>;
    const expected = query.data;
    return <div className="grid gap-2">
        <ShareForm key={JSON.stringify([request, query.data.map(s => [s.userId, s.role])])} colleagues={people.data} shares={query.data} request={request} t={t} busy={save.isPending} onConfirm={shares => save.mutate({shares, expected}, {onSuccess: onSaved})} />
        {save.isSuccess && <p role="status" className={META}>{t('cowork_task.share.saved', 'Access updated.')}</p>}
        <Failure error={save.error} t={t} />
    </div>;
}
