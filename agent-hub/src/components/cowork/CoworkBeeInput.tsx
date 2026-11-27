import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { TaskMessageInput } from './task/TaskMessageInput';
import type { SharedItem } from '@/api/coworkShares';
import type { CoworkItem } from '@/api/cowork.types';
import { useCoworkHomeRequest, type HomeAction } from '@/api/coworkHomeIntent';
import { useTranslation } from '@/hooks/useTranslation';
import CoworkOrb, { HasTaskOrb } from './CoworkOrb';
import type { ComposerSeed, HomeTransfer } from './coworkSheetPanels';
import { whenLine } from './coworkOverviewModel';
import { ALERT, LINK_INLINE } from './coworkUi';
import { homeShortcut } from './coworkHomeShortcuts';
import { teamworkRequest } from './coworkTeamworkRequest';
import type { CoworkSheetPanel } from './coworkSheetPanels';
import { choiceDetail } from './CoworkExistingTasks';

export interface HomeDestinations {
    panel: (panel: CoworkSheetPanel) => void;
    admin: boolean;
    embedded: boolean;
    context?: string;
    returnHome?: () => void;
    attention: ReactNode;
    emptyTasks?: ReactNode;
    shared: ReactNode;
    sharedItems: SharedItem[];
}
interface Props {
    seed?: ComposerSeed | null;
    children?: ReactNode;
    orb?: ComponentProps<typeof CoworkOrb>;
    advanced?: boolean;
    taskId?: string;
    pendingDraft?: string;
    onRefine?: (message: string) => void;
    preparing?: boolean;
    text: string;
    edit: ComponentProps<typeof TaskMessageInput>['setText'];
    go: (sentence?: string) => void;
    inputRef: RefObject<HTMLTextAreaElement | null>;
    items: CoworkItem[];
    ask?: (id: string, text: string, shared?: boolean) => void;
    open?: (id: string) => void;
    error?: string | null;
    atLimit: boolean;
    tier: string;
    destinations?: HomeDestinations;
}

type Candidate = CoworkItem & {sharedBy?: string};
type Choices = {tasks: Candidate[]; question?: string};
type Answer = {action: HomeAction | 'greeting'; answer?: string; indices?: number[]; section?: string; responses?: string[]; brief?: string};

function homePanel(action: 'org' | 'preferences' | 'teamwork' | 'templates', message: string, section?: string): CoworkSheetPanel {
    if (action === 'teamwork') return teamworkRequest(message, undefined, true) ?? {kind: 'teamwork'};
    return {kind: action === 'preferences' ? 'settings' : action, section};
}

function singleByTitle(items: Candidate[], message: string) {
    const matches = items.filter(item => item.title.toLowerCase() === message.toLowerCase());
    return matches.length === 1 ? matches[0] : undefined;
}

function namedQuestion(items: Candidate[], message: string) {
    if (!/^(?:why|waarom|share|deel|pause|pauzeer|resume|hervat|delete|verwijder|rename|hernoem)\b/i.test(message)) return;
    const titles = items.filter(item => item.title && message.toLowerCase().includes(item.title.toLowerCase()));
    return titles.length === 1 ? titles[0] : undefined;
}

function startHomeTask(sentence: string, {go, atLimit, destinations, items}: Pick<Props, 'go' | 'atLimit' | 'destinations' | 'items'>, notice: (value: string) => void, t: ReturnType<typeof useTranslation>['t']) {
    if (atLimit) return notice(t('cowork_home.at_limit', 'You have {count} tasks, the most you can have. Delete one to add another.', {count: items.length}));
    if (destinations?.embedded) destinations.returnHome?.();
    go(sentence);
}

function accessibleCandidates(owned: CoworkItem[], shared: SharedItem[] = []): Candidate[] {
    return [...owned, ...shared.map(task => ({...task, prompt: '', runCount: 0, sharedBy: task.ownerName}))];
}

function visitTask(task: Candidate, question: string | undefined, {ask, open, destinations}: Pick<Props, 'ask' | 'open' | 'destinations'>) {
    if (question) ask?.(task.id, question, task.sharedBy !== undefined);
    else if (task.sharedBy !== undefined) destinations?.panel({kind: 'shared', id: task.id});
    else open?.(task.id);
}

interface InterpreterProps {
    candidates: Candidate[];
    tier: string;
    context?: string;
    pendingDraft?: string;
    apply: (reply: Answer, message: string) => void;
    setNotice: (text: string) => void;
    t: ReturnType<typeof useTranslation>['t'];
}

function useHomeInterpreter({candidates, tier, context, pendingDraft, apply, setNotice, t}: InterpreterProps) {
    const requestIntent = useCoworkHomeRequest();
    const [failed, setFailed] = useState('');
    const request = useRef<AbortController | null>(null);
    const previous = useRef('');
    useLayoutEffect(() => () => request.current?.abort(), [pendingDraft, context]);
    async function interpret(message: string) {
        if (request.current) return;
        setFailed('');
        const control = new AbortController();
        request.current = control;
        try {
            const titles = candidates.map(task => task.sharedBy === undefined ? task.title : task.title + ' (shared by ' + task.sharedBy + ')');
            const reply = await requestIntent.mutateAsync({
                question: {message, titles, tier, previous: [previous.current, context, pendingDraft].filter(Boolean).join('\n')},
                signal: control.signal, partial: setNotice,
            });
            if (control.signal.aborted) return;
            const followup = !!previous.current;
            previous.current = reply.action === 'answer' ? [previous.current, message, reply.answer].filter(Boolean).join('\n').slice(-3500) : '';
            apply(followup ? reply : {...reply, brief: undefined}, message);
        } catch (err) {
            if (!control.signal.aborted) {
                setNotice(err instanceof Error ? err.message : t('cowork_panels.failed_try', 'That did not work. Try again.'));
                setFailed(message);
            }
        } finally {
            request.current = null;
        }
    }
    const forget = () => { previous.current = ''; setFailed(''); };
    return {interpret, forget, busy: requestIntent.isPending, failed};
}

function useHomeTurnQueue(preparing: boolean | undefined, submit: (message: string) => Promise<void>) {
    const [queued, setQueued] = useState('');
    const resume = useEffectEvent(async (message: string) => {
        await submit(message);
        setQueued('');
    });
    useEffect(() => {
        if (!queued || preparing) return;
        void resume(queued);
    }, [queued, preparing]);
    return {queued, queue: setQueued};
}

function useBeeHome({text, edit, go, items, ask, open, atLimit, destinations, tier, pendingDraft, onRefine, taskId, preparing}: Props) {
    const { t } = useTranslation();
    const [choices, setChoices] = useState<Choices | null>(null);
    const [notice, setNotice] = useState('');
    const [surface, setSurface] = useState<'shared' | 'attention' | null>(null);
    const { queued, queue } = useHomeTurnQueue(preparing, submit);
    const [responses, setResponses] = useState<string[]>([]);
    const candidates = accessibleCandidates(items, destinations?.sharedItems);
    const { interpret, busy, failed, forget } = useHomeInterpreter({ candidates, tier, context: destinations?.context, pendingDraft, apply, setNotice, t });
    const visit = (task: Candidate, question?: string) => visitTask(task, question, {ask, open, destinations});
    const pick = (task: Candidate) => visit(task, choices?.question);
    function createOrRefine(reply: Answer, message: string) {
        if (onRefine && reply.action === 'refine') return onRefine(message);
        if (onRefine) return setNotice(t('cowork_home.dialog.other_draft', 'Finish or cancel this draft before starting another task.'));
        if (reply.action === 'refine') return setNotice(t('cowork_home.dialog.help', 'Describe a new task, ask to see your tasks, or mention a task by name.'));
        return startHomeTask(reply.brief || message, {go, atLimit, destinations, items}, setNotice, t);
    }
    function proposeTask(reply: Answer, message: string) {
        const indices = reply.indices ?? [];
        const matches = indices.length ? candidates.filter((_, index) => indices.includes(index)) : items;
        if (matches.length === 1) return visit(matches[0], reply.action === 'open' ? undefined : message);
        if (matches.length) setNotice(t('cowork_home.existing.choose', 'Choose a task'));
        setChoices({tasks: matches, question: reply.action === 'open' ? undefined : message});
    }
    function apply(reply: Answer, message: string) {
        const {action, section} = reply;
        setChoices(null);
        setSurface(null);
        setResponses(reply.responses ?? []);
        setNotice('');
        if (action === 'create' || action === 'refine') return createOrRefine(reply, message);
        if (action === 'task' || action === 'open') return proposeTask(reply, message);
        if (action === 'tasks') return setChoices({tasks: items});
        if (action === 'shared' || action === 'attention') return setSurface(action);
        if (action === 'greeting') return setNotice(t('cowork_home.dialog.greeting', 'Hi! How can I help?'));
        if (action === 'answer') return setNotice(reply.answer || t('cowork_home.dialog.help', 'Describe a new task, ask to see your tasks, or mention a task by name.'));
        if (!destinations) return;
        if (action === 'org' && !destinations.admin) return setNotice(t('cowork_panels.org.not_admin', 'Only administrators of your organisation can see and change these rules.'));
        destinations.panel(homePanel(action, message, section));
    }
    function direct(message: string) {
        const shortcut = homeShortcut(message);
        if (shortcut === 'create' && pendingDraft) return false;
        if (shortcut) { forget(); apply({action: shortcut}, message); return true; }
        const exact = singleByTitle(candidates, message);
        if (exact) {
            pick(exact);
            return true;
        }
        const target = namedQuestion(candidates, message);
        if (target) {
            visit(target, message);
            return true;
        }
        return false;
    }
    async function submit(override?: string) {
        const message = (override ?? text).trim();
        if (!message || busy) return;
        if (override === undefined) edit('');
        if (preparing) {
            queue(message);
            return;
        }
        if (taskId && ask) { ask(taskId, message); return; }
        if (direct(message)) return;
        setChoices(null);
        setSurface(null);
        setResponses([]);
        setNotice('');
        await interpret(message);
    }
    return {apply, submit, choices, pick, notice, surface, busy, responses, queued, failed};
}

function TaskChoices({choices, pick, empty}: {choices: Choices; pick: (task: Candidate) => void; empty?: ReactNode}) {
    const {t} = useTranslation();
    if (!choices.tasks.length) return empty ?? <p role="status">{t('cowork_home.dialog.no_tasks', 'You have no tasks yet. What would you like me to do?')}</p>;
    return <div className="cowork-bee-options">
        {choices.tasks.map(task => <button type="button" key={task.id} className={LINK_INLINE} onClick={() => pick(task)}>
            {task.title}<small>{task.sharedBy ? t('cowork_home.shared.sees', 'From {owner} · you can see it', {owner: task.sharedBy}) : choiceDetail(task, choices.tasks, t) || whenLine(task, t)}</small>
        </button>)}
    </div>;
}

function useHomeTransfer({seed, destinations, inputRef, edit}: Props,
    apply: (reply: Answer, text: string) => void, submit: (text: string) => Promise<void>) {
    const routeIncoming = useEffectEvent((action: HomeTransfer, text: string) => {
        edit('');
        if (action === 'ask') void submit(text);
        else apply({action}, text);
    });
    useEffect(() => {
        if (inputRef.current?.closest('[hidden]')) return;
        const action = seed?.takeAction?.();
        if (seed && action) routeIncoming(action, seed.text);
    }, [seed, destinations?.context, inputRef]);
}

export default function CoworkBeeInput(props: Props) {
    const { t } = useTranslation();
    const {text, edit, inputRef, error, destinations} = props;
    const {apply, submit, choices, pick, notice, surface, busy, responses, queued, failed} = useBeeHome(props);
    useHomeTransfer(props, apply, submit);
    const inputIds = props.advanced ? {id: 'cowork-bee-message', testId: 'cowork-bee-message'} : {id: 'cowork-brief', testId: 'cowork-brief-input'};
    return <div className="cowork-bee-dialog">
        {!destinations?.embedded && <div className="cowork-welcome-orb"><CoworkOrb tone={busy ? 'thinking' : 'rest'} {...props.orb} /></div>}
        <HasTaskOrb.Provider value><div className="cowork-home-context">
            {props.children}
            {choices && <TaskChoices choices={choices} pick={pick} empty={destinations?.emptyTasks} />}
            {surface && destinations?.[surface]}
            {error && <p role="alert" className={ALERT}>{error}</p>}
            {notice && <p role="status">{notice}</p>}
            {queued && <p role="status">{t('cowork_home.dialog.queued', 'I’ll take this up with your task in a moment.')}</p>}
            {failed && <button type="button" className={LINK_INLINE} onClick={() => void submit(failed)}>{t('cowork_task.retry', 'Try again')}</button>}
            {responses.length > 0 && <div className="cowork-answer-options">{responses.map(value =>
                <button type="button" key={value} disabled={busy} onClick={() => void submit(value)}>{value}</button>)}</div>}
        </div></HasTaskOrb.Provider>
        <div className="cowork-conversation" data-bee-pending={Boolean(queued)}>
            <TaskMessageInput text={text} setText={edit} inputRef={inputRef} send={() => { void submit(); }} busy={busy || !!queued}
                {...inputIds} maxLength={4000} />
        </div>
    </div>;
}
