/**
 * The desks one person is on, as cards on the Teamwork page: who holds each role and who stands in, the colleagues an
 * invitation still waits for, and how the result flows from one person's task to the next. The two things the reader
 * decides for their own tasks sit in the card: accepting an invitation once, and allowing a colleague's task to receive
 * the result of theirs (server/usecases/coworkDesks.mts).
 */
import { useState } from 'react';
import { useItemDesk, type PlannedStart, useDeskHandOff, useDeskView, useItemDeskActions, type DeskMember, type DeskView } from '@/api/coworkDesks';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { CARD_INSET } from '../coworkUi';
import { BODY, CARD, META, PanelButton, PanelLoading, PanelReadProblem, Problem } from './panelParts';

const ownerOf = (m: DeskMember, t: TranslateFn): string => (m.mine ? t('cowork_panels.team.you', 'you') : m.ownerName);

export function AcceptDeskInvitation({deskId, member, done}: {deskId: string; member: DeskMember; done: (planned: PlannedStart | null) => void}) {
    const {t} = useTranslation();
    const invitation = useItemDesk(member.scheduleId);
    const {accept} = useItemDeskActions(member.scheduleId);
    const details = invitation.data;
    const start = details?.plannedAfter;
    const label = start
        ? t('cowork_desks.accept_and_start', 'Accept, and start "{title}" after {owner}\'s "{after}"', {title: member.title, owner: start.ownerName, after: start.title})
        : t('cowork_panels.team.accept', 'Accept “{title}”', { title: member.title });
    return <>
        <PanelButton disabled={details?.id !== deskId || details.accepted} busy={accept.isPending}
            onClick={() => accept.mutate(deskId, {onSuccess: result => done(result.plannedStart ?? null)})}>{label}</PanelButton>
        <Problem error={invitation.error ?? accept.error} fallback={t('cowork_panels.failed_try', 'That did not work. Try again.')} />
    </>;
}

export function DeskStartStatus({start}: {start: PlannedStart}) {
    const {t} = useTranslation();
    return <p className={META} role="status">{start.applied
        ? t('cowork_desks.planned_applied', 'Accepted. It starts after "{after}" now.', {after: start.afterTitle})
        : t('cowork_desks.planned_refused', 'Accepted. It could not start after "{after}": {reason}', {after: start.afterTitle, reason: start.reason ?? ''})}</p>;
}

function Flow({ deskId, member, leader }: { deskId: string; member: DeskMember; leader: DeskMember }) {
    const { t } = useTranslation();
    const { allow, withdraw } = useDeskHandOff(deskId);
    const sentence = t('cowork_panels.team.sends_each', '“{fromTitle}” ({from}) sends each result to “{toTitle}” ({to}).', { from: ownerOf(leader, t), fromTitle: leader.title, to: ownerOf(member, t), toTitle: member.title });
    return (
        <li className="flex flex-col items-start gap-1.5" data-testid="cowork-team-flow">
            <span className={BODY}>{sentence}</span>
            {member.handOff === 'waiting' && !member.decidesHandOff && <span className={META}>{t('cowork_panels.team.flow_waiting', 'It receives nothing until {owner} allows it.', { owner: leader.ownerName })}</span>}
            {member.decidesHandOff && member.handOff === 'waiting' && (
                <PanelButton look="secondary" busy={allow.isPending} onClick={() => allow.mutate(member.scheduleId)}>{t('cowork_panels.team.allow', 'Allow it')}</PanelButton>
            )}
            {member.decidesHandOff && member.handOff === 'allowed' && (
                <PanelButton look="link" busy={withdraw.isPending} onClick={() => withdraw.mutate(member.scheduleId)}>{t('cowork_panels.team.stop', 'Stop sending it')}</PanelButton>
            )}
            <Problem error={allow.error ?? withdraw.error} fallback={t('cowork_panels.failed_try', 'That did not work. Try again.')} />
        </li>
    );
}

function joinAnd(names: string[], locale: string): string {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
}

function DeskBody({ view, onOpenTask }: { view: DeskView; onOpenTask: (id: string) => void }) {
    const { t, locale } = useTranslation();
    const [accepted, setAccepted] = useState<PlannedStart | null>(null);
    const waitingFor = [...new Set(view.members.filter((m) => !m.accepted).map((m) => ownerOf(m, t)))];
    const mineInvited = view.members.filter((m) => m.mine && !m.accepted);
    const flows = view.members.filter((m) => m.after).map((m) => ({ m, leader: view.members.find((l) => l.scheduleId === m.after) })).filter((f): f is { m: DeskMember; leader: DeskMember } => !!f.leader);
    return (
        <>
            {waitingFor.length > 0 && (
                <p className={`m-0 p-3 ${CARD_INSET} ${META}`} role="status">
                    {t('cowork_panels.team.waiting_for', 'Waiting for {names} to accept. It takes them one click.', { names: joinAnd(waitingFor, locale) })}
                </p>
            )}
            {accepted && <DeskStartStatus start={accepted}/>}
            {mineInvited.map((m) => <AcceptDeskInvitation key={m.scheduleId} deskId={view.desk.id} member={m} done={setAccepted}/>)}
            {view.roles.length > 0 && (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {view.roles.map((r) => (
                        <li key={r.role} className="flex flex-wrap items-baseline gap-x-3 text-[14px] leading-5" data-testid="cowork-team-role-line">
                            <span className="min-w-[10rem] flex-1 font-semibold text-[var(--text-primary)]">{r.role}</span>
                            <span className="text-[var(--text-primary)]">{r.holderName ?? t('cowork_panels.team.nobody', 'Nobody')}</span>
                            <span className={META}>{t('cowork_panels.team.stand_in_line', 'stand-in: {name}', { name: r.standInName ?? t('cowork_panels.team.nobody', 'Nobody').toLowerCase() })}</span>
                        </li>
                    ))}
                </ul>
            )}
            {flows.length > 0 && <ul className="m-0 flex list-none flex-col gap-2 p-0">{flows.map(({ m, leader }) => <Flow key={m.scheduleId} deskId={view.desk.id} member={m} leader={leader} />)}</ul>}
            <div className="flex flex-wrap gap-2">
                {view.members.filter((m) => m.mine && m.accepted).map((m) => (
                    <PanelButton look="link" key={m.scheduleId} onClick={() => onOpenTask(m.scheduleId)}>{t('cowork_panels.team.open_task', 'Open “{title}”', { title: m.title })}</PanelButton>
                ))}
            </div>
        </>
    );
}

export default function CoworkTeamworkDesk({ deskId, name, isOwner, onOpenTask }: { deskId: string; name: string; isOwner: boolean; onOpenTask: (id: string) => void }) {
    const { t } = useTranslation();
    const view = useDeskView(deskId);
    return (
        <article className={CARD} aria-label={name} data-testid="cowork-team-desk">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="m-0 text-[14px] leading-5 font-semibold text-[var(--text-primary)]">{name}</h3>
                <span className={META}>{isOwner
                    ? t('cowork_panels.team.set_up_by_you', 'Set up by you')
                    : view.data?.desk.ownerName && t('cowork_panels.team.set_up_by', 'Set up by {name}', { name: view.data.desk.ownerName })}</span>
            </div>
            {view.isPending && <PanelLoading />}
            {view.data && <DeskBody view={view.data} onOpenTask={onOpenTask} />}
            <PanelReadProblem error={view.error} retry={() => void view.refetch()} />
        </article>
    );
}
