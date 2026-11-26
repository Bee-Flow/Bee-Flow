import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useDraftDesk, type HelperResult } from '@/api/coworkDeskHelper';
import { useDeskView, useItemDesk, useItemDeskActions, useMyDesks, useRemoveDesk, type DeskSummary, type DeskMember, type DeskView, type PlannedStart } from '@/api/coworkDesks';

import useCoworkList from '../useCoworkList';
import CoworkActivity from '../CoworkActivity';
import type { TeamworkTurn } from '../coworkTeamworkRequest';
import CoworkTeamworkDesk, { AcceptDeskInvitation, DeskStartStatus } from './CoworkTeamworkDesks';
import { DeskProposalForm, DeskSetupResult } from './CoworkTeamworkSetup';
import { CreateDeskForm, DeskRoles, MemberRole } from './CoworkDeskAdministration';
import { INPUT, LabeledField, PanelButton, Problem } from './panelParts';

function Draft({words, itemId, onBack}: {words: string; itemId?: string; onBack: () => void}) {
    const { t } = useTranslation();
    const {mutate, data, error, isPending} = useDraftDesk();
    const started = useRef(false);
    const [sent, setSent] = useState<HelperResult | null>(null);
    useEffect(() => {
        if (started.current) return;
        started.current = true;
        mutate({text: words, itemId});
    }, [mutate, words, itemId]);
    if (sent) return <DeskSetupResult result={sent} onAgain={onBack} />;
    if (data) return <DeskProposalForm proposal={data} itemId={itemId} onBack={onBack} onDone={setSent} />;
    if (isPending) return <p role="status">{t('cowork_teamwork.thinking', 'Working it out…')}</p>;
    return <Problem error={error} fallback={t('cowork_desks.failed', 'That did not work. Try again.')} />;
}

function ConfirmMembership({desk, id, leaving, done}: {desk: DeskSummary; id: string; leaving: boolean; done: () => void}) {
    const {t} = useTranslation();
    const info = useItemDesk(id, !!id && !leaving);
    const actions = useItemDeskActions(id);
    const op = leaving ? actions.leave : actions.join;
    const otherDesk = !leaving && info.data?.id !== desk.id ? info.data : null;
    return <>
        {otherDesk && <p>{t('cowork_desks.on', 'On the desk "{desk}".', {desk: otherDesk.name})}</p>}
        <PanelButton disabled={!id || info.isLoading || !!otherDesk || !!info.error} busy={op.isPending}
            onClick={() => op.mutate(desk.id, {onSuccess: done})}>{leaving ? t('cowork_desks.leave', 'Take it off the desk') : t('cowork_desks.join', 'Put it on this desk')}</PanelButton>
        <Problem error={op.error ?? info.error} fallback={t('cowork_desks.failed', 'That did not work. Try again.')} />
    </>;
}

type TaskChoice = { id: string; title: string };

function memberChoices(tasks: TaskChoice[], members: DeskMember[], turn: TeamworkTurn, deskOwner: boolean): TaskChoice[] {
    if (turn.mode === 'task-role') return members.filter(member => member.mine && member.accepted).map(member => ({id: member.scheduleId, title: member.title}));
    if (turn.mode === 'leave') return members.filter(member => member.mine || deskOwner).map(member => ({id: member.scheduleId, title: member.title}));
    return tasks.filter(task => !members.some(member => member.scheduleId === task.id && member.accepted));
}

function preselectTask(turn: TeamworkTurn, options: TaskChoice[]) {
    const named = options.filter(task => turn.message.toLocaleLowerCase().includes(task.title.toLocaleLowerCase()));
    if (named.length) return named.length === 1 ? named[0].id : '';
    return options.find(task => task.id === turn.itemId)?.id ?? '';
}

function TaskPicker({id, options, turn, choose}: {id: string; options: TaskChoice[]; turn: TeamworkTurn; choose: (value: string) => void}) {
    const {t} = useTranslation();
    const selected = options.find(task => task.id === id);
    if (selected && id === turn.itemId) return <p>{selected.title}</p>;
    return <LabeledField id="cowork-desk-task" label={t('cowork_teamwork.choose_cowork', 'Choose a cowork')}>
        <select id="cowork-desk-task" className={INPUT} value={id} onChange={e => choose(e.target.value)}><option value=""/>{options.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select>
    </LabeledField>;
}

function MembershipAction({desk, id, turn, view, done, accept}: {desk: DeskSummary; id: string; turn: TeamworkTurn; view: DeskView; done: () => void; accept: (result: PlannedStart | null) => void}) {
    const member = view.members.find(m => m.scheduleId === id);
    if (turn.mode === 'join' && member) return <AcceptDeskInvitation deskId={desk.id} member={member} done={accept}/>;
    if (turn.mode === 'task-role') return member && <MemberRole key={id} deskId={desk.id} member={member} roles={view.roles} done={done}/>;
    return <ConfirmMembership desk={desk} id={id} leaving={turn.mode === 'leave'} done={done} />;
}

function Membership({desk, turn, done}: {desk: DeskSummary; turn: TeamworkTurn; done: () => void}) {
    const { t } = useTranslation();
    const tasks = useCoworkList();
    const detail = useDeskView(desk.id);
    const [chosen, choose] = useState('');
    const [started, setStarted] = useState<PlannedStart | null>(null);
    if (started) return <DeskStartStatus start={started}/>;
    const problem = detail.error ?? tasks.error;
    if (problem) return <Problem error={problem} fallback={t('cowork_desks.failed', 'That did not work. Try again.')} />;
    if (!tasks.data || !detail.data) return null;
    const eligible = memberChoices(tasks.data.items, detail.data.members, turn, desk.isOwner);
    if (!eligible.length) return <p>{t('cowork_teamwork.no_matching_tasks', 'None of your tasks can make this change on this desk.')}</p>;
    const id = chosen || preselectTask(turn, eligible);
    return <div className="grid gap-2">
        <TaskPicker id={id} options={eligible} turn={turn} choose={choose}/>
        <MembershipAction desk={desk} id={eligible.some(task => task.id === id) ? id : ''} turn={turn} view={detail.data} done={done} accept={result => result ? setStarted(result) : done()}/>
    </div>;
}

function DraftForDesk({desk, turn, done}: {desk?: DeskSummary; turn: TeamworkTurn; done: () => void}) {
    const {t} = useTranslation();
    const view = useDeskView(desk?.id ?? null);
    if (desk && !view.data) return <Problem error={view.error} fallback={t('cowork_desks.failed', 'That did not work. Try again.')} />;
    const own = view.data?.members.filter(member => member.mine && member.accepted);
    const anchor = desk ? (own?.find(member => member.scheduleId === turn.itemId) ?? own?.[0])?.scheduleId : turn.itemId;
    if (desk && !desk.isOwner) return <p>{t('cowork_teamwork.owner_anchor', 'To change this setup, the desk owner needs an accepted task on the desk.')}</p>;
    if (desk && !anchor) return <><p>{t('cowork_teamwork.pick_anchor', 'Which of your tasks should join this desk?')}</p>
        <Membership desk={desk} turn={{...turn, mode:'join'}} done={() => { void view.refetch(); }} /></>;
    return <Draft words={turn.message} itemId={anchor} onBack={done} />;
}

function RequestedAction({desk, turn, done, created, onOpenTask}: {created: (id: string) => void; desk?: DeskSummary; turn: TeamworkTurn; done: () => void; onOpenTask: (id: string) => void}) {
    const {t} = useTranslation();
    const remove = useRemoveDesk(desk?.id ?? '');
    if (turn.mode === 'create') return <CreateDeskForm message={turn.message} onCreated={created} />;
    if (turn.mode === 'setup') return <DraftForDesk desk={desk} turn={turn} done={done} />;
    if (!desk) return <p>{t('cowork_teamwork.no_desks', 'You don’t have a team desk yet.')}</p>;
    if (turn.mode === 'roles') return <DeskRoles desk={desk} message={turn.message} done={done} />;
    if (turn.mode === 'browse') return <CoworkTeamworkDesk deskId={desk.id} name={desk.name} isOwner={desk.isOwner} onOpenTask={onOpenTask} />;
    if (turn.mode !== 'remove') return <Membership desk={desk} turn={turn} done={done} />;
    if (!desk.isOwner) return <p>{t('cowork_teamwork.remove_owner', 'Only the desk owner can remove it.')}</p>;
    return <div className="grid gap-2"><p>{t('cowork_teamwork.remove_confirm', 'Remove the desk “{name}” and its connections?', {name: desk.name})}</p>
        <div className="flex gap-2"><PanelButton busy={remove.isPending} onClick={() => remove.mutate(undefined, {onSuccess: done})}>{t('cowork_desks.remove_desk', 'Remove the desk')}</PanelButton>
            <PanelButton look="link" disabled={remove.isPending} onClick={done}>{t('cowork_teamwork.cancel', 'Not now')}</PanelButton></div>
        <Problem error={remove.error} fallback={t('cowork_desks.failed', 'That did not work. Try again.')} /></div>;
}

function deskByName(desks: DeskSummary[], words: string) {
    const msg = words.toLocaleLowerCase();
    const named = desks.filter(desk => msg.includes(desk.name.toLocaleLowerCase()));
    return named.length === 1 ? named[0] : undefined;
}

function requestedDesk(desks: DeskSummary[], turn: TeamworkTurn, chosen: string, current?: string) {
    if (chosen) return desks.find(d => d.id === chosen);
    if (turn.mode === 'create' || explicitlyNew(turn.message)) return undefined;
    const selected = deskByName(desks, turn.message);
    if (selected) return selected;
    const context = desks.find(d => d.id === current);
    if (turn.mode === 'browse') return context ?? (desks.length === 1 ? desks[0] : undefined);
    return context && (turn.mode === 'setup' || thisDesk(turn.message)) ? context : undefined;
}

function explicitlyNew(message: string) {
    return /\b(?:new|nieuwe?)\s+(?:team\s+desk|teamdesk|desk|team|bureau)\b/i.test(message);
}

function thisDesk(message: string) {
    return /\b(?:this|the current|deze|de huidige)\s+(?:team|desk)|\b(?:hier|here|eruit|erbij)\b/i.test(message);
}

function nextDesk(desks: DeskSummary[], request: TeamworkTurn, target?: DeskSummary) {
    const named = deskByName(desks, request.message);
    if (named) return named.id;
    return thisDesk(request.message) ? target?.id ?? '' : '';
}

interface GuideFormProps {
    turn: TeamworkTurn;
    desks: DeskSummary[];
    target?: DeskSummary;
    chosen: string;
    currentDesk?: string;
    choose: (id: string) => void;
    showDesk: (id?: string) => void;
    onOpenTask: (id: string) => void;
}

function GuideForm({turn, desks, target, chosen, currentDesk, choose, showDesk, onOpenTask}: GuideFormProps) {
    const {t} = useTranslation();
    const buildNew = turn.mode === 'setup' && (chosen === '__new' || explicitlyNew(turn.message) || !desks.length);
    const targetTurn = buildNew && currentDesk ? {...turn, itemId: undefined} : turn;
    if (target || turn.mode === 'create' || buildNew || !desks.length) return <RequestedAction key={target?.id} created={showDesk}
        desk={target} turn={targetTurn} done={() => showDesk(target?.id)} onOpenTask={onOpenTask} />;
    return <LabeledField id="cowork-orb-desk" label={t('cowork_desks.choose_none', 'Choose a desk')}>
        <select id="cowork-orb-desk" className={INPUT} value="" onChange={e => choose(e.target.value)}><option value=""/>
            {desks.map(d => <option value={d.id} key={d.id}>{d.name}</option>)}
            {turn.mode === 'setup' && <option value="__new">{t('cowork_teamwork.create_desk', 'Create desk')}</option>}
        </select>
    </LabeledField>;
}

export default function GuidedTeamwork({initial, onOpenTask}: {initial: TeamworkTurn; onOpenTask: (id: string) => void}) {
    const {t} = useTranslation();
    const [turn, setTurn] = useState(initial);
    const [chosen, choose] = useState('');
    const [previous, setPrevious] = useState(initial);
    const [round, nextRound] = useState(0);
    const mine = useMyDesks();
    const current = useItemDesk(turn.itemId ?? '', !!turn.itemId);
    const desks = mine.data ?? [];
    const target = requestedDesk(desks, turn, chosen, current.data?.id);
    const showDesk = (id?: string) => {
        choose(id ?? '');
        setTurn({mode: 'browse', message: ''});
        nextRound(n => n + 1);
    };
    if (previous !== initial) {
        setPrevious(initial);
        choose(nextDesk(desks, initial, target));
        setTurn(initial);
        nextRound(n => n + 1);
    }
    const problem = mine.error ?? current.error;
    const ready = !mine.isLoading && !current.isLoading && !problem;
    const title = t('cowork_panels.team.title', 'Teamwork');
    return <section className="cowork-task-guided" data-testid="cowork-teamwork-panel"><h1 className="sr-only">{title}</h1>
        <CoworkActivity tone="rest" work={{action:'ask'}} message={target?.name ?? title}>
            <div className="flex w-full max-w-lg flex-col gap-3 text-left">
                <Problem error={problem} fallback={t('cowork_desks.failed', 'That did not work. Try again.')} />
                {ready && <GuideForm key={round} turn={turn} desks={desks} target={target} chosen={chosen} currentDesk={current.data?.id}
                    choose={choose} showDesk={showDesk} onOpenTask={onOpenTask} />}
            </div>
        </CoworkActivity>
    </section>;
}
