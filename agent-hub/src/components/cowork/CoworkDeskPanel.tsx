/**
 * "Work on this together", in the People section of an item's Settings tab (./CoworkSettings.tsx): the desk this
 * cowork is on (server/usecases/coworkDesks.mts). Coworks of different owners on one desk hand work to each other: a
 * cowork that starts after another one on the desk gets only that run's result, and runs as its own owner, with its
 * own connections. Here the owner puts the cowork on a desk (or makes one), accepts or declines an invitation, chooses
 * which role of the desk decides its questions, and takes it off again. The desk's maker also sets its roles.
 */
import { useState } from 'react';
import { Network } from 'lucide-react';
import CoworkDeskChain from './CoworkDeskChain';
import CoworkDeskRoles from './CoworkDeskRoles';
import CoworkTeamworkHelper from './CoworkTeamworkHelper';
import { useDeskView, useItemDesk, useItemDeskActions, useMyDesks, type DeskMember, type ItemDesk } from '@/api/coworkDesks';
import { useCoworkStart } from '@/api/coworkStart';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import type { TranslateFn } from '@/hooks/useTranslation';

const FIELD = 'rounded-lg border px-2 py-1 text-[12px] bg-[var(--bg-primary)] [border-color:var(--border-default)]';
const BUTTON = 'px-3 py-1.5 rounded-lg border text-[12px] font-medium [border-color:var(--border-default)] disabled:opacity-50';
const LINK = 'self-start text-[12px] text-[var(--text-secondary)] underline underline-offset-2';

type Actions = ReturnType<typeof useItemDeskActions>;

function Failure({ actions, t }: { actions: Actions; t: TranslateFn }) {
    const error = Object.values(actions).map((a) => a.error).find(Boolean);
    if (!error) return null;
    return <p role="alert" className="text-[12px] text-[var(--error-ink)]">{errorMessage(error) || t('cowork_desks.failed', 'That did not work. Try again.')}</p>;
}

/** Not on a desk: put it on one of mine, or make a new one. */
function Join({ actions, t }: { actions: Actions; t: TranslateFn }) {
    const desks = useMyDesks().data ?? [];
    const [deskId, setDeskId] = useState('');
    const [name, setName] = useState('');
    const busy = actions.join.isPending || actions.create.isPending;
    return (
        <div className="flex flex-col gap-2">
            {desks.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                    <select aria-label={t('cowork_desks.choose', 'Desk to put it on')} className={FIELD} value={deskId} onChange={(e) => setDeskId(e.target.value)}>
                        <option value="">{t('cowork_desks.choose_none', 'Choose a desk')}</option>
                        {desks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                    <button type="button" className={BUTTON} disabled={!deskId || busy} onClick={() => actions.join.mutate(deskId)}>{t('cowork_desks.join', 'Put it on this desk')}</button>
                </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <input aria-label={t('cowork_desks.new_name', 'Name of a new desk')} placeholder={t('cowork_desks.new_placeholder', 'For example: Invoices')} className={FIELD} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                <button type="button" className={BUTTON} disabled={!name.trim() || busy} onClick={() => actions.create.mutate(name.trim(), { onSuccess: () => setName('') })}>{t('cowork_desks.create', 'Make a desk with it')}</button>
            </div>
        </div>
    );
}

/** Invited by the desk's maker: it joins only when I accept. */
function Invitation({ desk, actions, t }: { desk: ItemDesk; actions: Actions; t: TranslateFn }) {
    return (
        <div className="flex flex-col gap-2" data-testid="cowork-desk-invitation">
            <p className="text-[12px] text-[var(--text-secondary)]">
                {t('cowork_desks.invitation', '{name} invited this cowork to the desk "{desk}". It joins only when you accept; it keeps running as you.', { name: desk.invitedBy ?? t('cowork_desks.someone', 'Someone'), desk: desk.name })}
            </p>
            <div className="flex gap-2">
                <button type="button" className={BUTTON} disabled={actions.accept.isPending} onClick={() => actions.accept.mutate(desk.id)}>{t('cowork_desks.accept', 'Accept')}</button>
                <button type="button" className={BUTTON} disabled={actions.leave.isPending} onClick={() => actions.leave.mutate(desk.id)}>{t('cowork_desks.decline', 'Decline')}</button>
            </div>
        </div>
    );
}

/**
 * Start this cowork after a colleague's cowork on the desk: the hand-off. Saved as its start ("after another cowork",
 * ./CoworkStartPanel.tsx shows it there too), which takes the plan's approval away like any change of start.
 */
function StartAfter({ coworkId, members, t }: { coworkId: string; members: DeskMember[]; t: TranslateFn }) {
    const { choose } = useCoworkStart(coworkId, false);
    const [after, setAfter] = useState('');
    const theirs = members.filter((m) => !m.mine && m.accepted && m.scheduleId !== coworkId);
    if (theirs.length === 0) return null;
    return (
        <div className="flex flex-wrap items-center gap-2">
            <select aria-label={t('cowork_desks.start_after', 'Start it after')} className={FIELD} value={after} onChange={(e) => setAfter(e.target.value)}>
                <option value="">{t('cowork_desks.start_after_none', 'Choose a colleague\'s cowork')}</option>
                {theirs.map((m) => <option key={m.scheduleId} value={m.scheduleId}>{t('cowork_desks.member_option', '{title} ({owner})', { title: m.title, owner: m.ownerName })}</option>)}
            </select>
            <button type="button" className={BUTTON} disabled={!after || choose.isPending} onClick={() => choose.mutate({ kind: 'after_cowork', scheduleId: after })}>{t('cowork_desks.start_after_save', 'Start it after that one')}</button>
            {choose.isSuccess && <span className="text-[12px] text-[var(--text-secondary)]">{t('cowork_desks.start_after_saved', 'Saved. It gets only the result of that run, once its owner allows it.')}</span>}
            {choose.error && <span role="alert" className="text-[12px] text-[var(--error-ink)]">{errorMessage(choose.error) || t('cowork_desks.failed', 'That did not work. Try again.')}</span>}
        </div>
    );
}

/** On a desk: the coworks on it, the role that decides this one's questions, and leaving. Its maker may also change it with the helper. */
function OnDesk({ coworkId, desk, actions, t, onHelper }: { coworkId: string; desk: ItemDesk; actions: Actions; t: TranslateFn; onHelper: () => void }) {
    const view = useDeskView(desk.id).data;
    return (
        <div className="flex flex-col gap-2" data-testid="cowork-desk-on">
            <p className="text-[12px] text-[var(--text-secondary)]">{t('cowork_desks.on', 'On the desk "{desk}".', { desk: desk.name })}</p>
            {view?.desk.isOwner && <button type="button" className={LINK} onClick={onHelper}>{t('cowork_teamwork.change_with_helper', 'Change with the helper')}</button>}
            {view && <CoworkDeskChain deskId={view.desk.id} members={view.members} />}
            {view && <StartAfter coworkId={coworkId} members={view.members} t={t} />}
            <label className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                {t('cowork_desks.decides', 'Who decides its questions')}
                <select className={FIELD} value={desk.deskRole ?? ''} disabled={actions.chooseRole.isPending} onChange={(e) => actions.chooseRole.mutate({ deskId: desk.id, deskRole: e.target.value || null })}>
                    <option value="">{t('cowork_desks.decides_as_before', 'As without the desk')}</option>
                    {(view?.roles ?? []).map((r) => <option key={r.role} value={r.role}>{r.role}</option>)}
                </select>
            </label>
            {view?.desk.isOwner && <CoworkDeskRoles key={view.roles.map((r) => r.role).join('|')} view={view} />}
            <div>
                <button type="button" className={BUTTON} disabled={actions.leave.isPending} onClick={() => actions.leave.mutate(desk.id)}>{t('cowork_desks.leave', 'Take it off the desk')}</button>
            </div>
        </div>
    );
}

/** Not on a desk yet: the Teamwork helper first ("Help me set this up"), every setting under "All settings". */
function NoDesk({ actions, t, onHelper, startAll }: { actions: Actions; t: TranslateFn; onHelper: () => void; startAll: boolean }) {
    const [all, setAll] = useState(startAll);
    return (
        <div className="flex flex-col gap-2">
            <button type="button" className={`${BUTTON} self-start`} onClick={onHelper}>{t('cowork_teamwork.open', 'Help me set this up')}</button>
            {all ? <Join actions={actions} t={t} /> : <button type="button" className={LINK} onClick={() => setAll(true)}>{t('cowork_teamwork.all_settings', 'All settings')}</button>}
        </div>
    );
}

export default function CoworkDeskPanel({ coworkId }: { coworkId: string }) {
    const { t } = useTranslation();
    const query = useItemDesk(coworkId);
    const actions = useItemDeskActions(coworkId);
    const desk = query.data ?? null;
    // While the helper is open it stays, also after it set the desk up: its last screen says what waits for whom.
    const [helper, setHelper] = useState(false);
    const [allSettings, setAllSettings] = useState(false);
    if (helper) return <CoworkTeamworkHelper itemId={coworkId} onClose={() => setHelper(false)} onAllSettings={() => { setHelper(false); setAllSettings(true); }} />;
    return (
        <div data-testid="cowork-desk" className="flex flex-col gap-2">
            <h4 className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-primary)]">
                <Network aria-hidden="true" className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                {t('cowork_desks.heading', 'Work on this together')}
            </h4>
            <p className="text-[12px] text-[var(--text-secondary)]">
                {t('cowork_desks.hint', 'On a desk, coworks of colleagues hand work to each other. Each runs as its own owner, with its own connections: only the result goes on to the next.')}
            </p>
            {query.isSuccess && !desk && <NoDesk actions={actions} t={t} onHelper={() => setHelper(true)} startAll={allSettings} />}
            {desk && !desk.accepted && <Invitation desk={desk} actions={actions} t={t} />}
            {desk?.accepted && <OnDesk coworkId={coworkId} desk={desk} actions={actions} t={t} onHelper={() => setHelper(true)} />}
            <Failure actions={actions} t={t} />
        </div>
    );
}
