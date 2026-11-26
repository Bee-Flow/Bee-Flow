import { useEffect, useEffectEvent, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowUp } from 'lucide-react';
import type { SharedItem } from '@/api/coworkShares';
import type { CoworkItem } from '@/api/cowork.types';
import { locateCoworkRequest, type HomeAction } from '@/api/coworkHomeIntent';
import { useTranslation } from '@/hooks/useTranslation';
import CoworkOrb from './CoworkOrb';
import { whenLine } from './coworkOverviewModel';
import { LINK_INLINE } from './coworkUi';
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
    shared: ReactNode;
    sharedItems: SharedItem[];
}
interface Props {
    seed?: import('./coworkSheetPanels').ComposerSeed | null;
    text: string;
    edit: (value: string) => void;
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

function useBeeHome({text, edit, go, items, ask, open, atLimit, destinations, tier}: Props) {
    const { t } = useTranslation();
    const [choices, setChoices] = useState<Choices | null>(null);
    const [notice, setNotice] = useState('');
    const [surface, setSurface] = useState<'shared' | 'attention' | null>(null);
    const [busy, setBusy] = useState(false);
    const request = useRef<AbortController | null>(null);
    const previous = useRef('');
    useEffect(() => () => request.current?.abort(), []);
    const [responses, setResponses] = useState<string[]>([]);
    const candidates = accessibleCandidates(items, destinations?.sharedItems);
    const visit = (task: Candidate, question?: string) => visitTask(task, question, {ask, open, destinations});
    function proposeTask(reply: Answer, message: string) {
        const indices = reply.indices ?? [];
        const matches = indices.length ? candidates.filter((_, index) => indices.includes(index)) : items;
        if (matches.length === 1) return visit(matches[0], reply.action === 'open' ? undefined : message);
        setNotice(t('cowork_home.existing.choose', 'Choose a task'));
        setChoices({tasks: matches, question: reply.action === 'open' ? undefined : message});
    }
    function apply(reply: Answer, message: string) {
        const {action, section} = reply;
        setChoices(null);
        setSurface(null);
        setResponses(reply.responses ?? []);
        setNotice('');
        if (action === 'create') return startHomeTask(reply.brief || message, {go, atLimit, destinations, items}, setNotice, t);
        edit('');
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
        if (shortcut) { previous.current = ''; apply({action: shortcut}, message); return true; }
        const exact = singleByTitle(candidates, message);
        if (exact) {
            edit('');
            pick(exact);
            return true;
        }
        const target = namedQuestion(candidates, message);
        if (target) {
            edit('');
            visit(target, message);
            return true;
        }
        return false;
    }
    async function submit(override?: string) {
        const message = (override ?? text).trim();
        if (!message || request.current || direct(message)) return;
        const control = new AbortController();
        request.current = control;
        setBusy(true);
        try {
            const reply = await locateCoworkRequest({message, titles: candidates.map(task => task.sharedBy === undefined ? task.title : task.title + ' (shared by ' + task.sharedBy + ')'), tier,
                previous: [destinations?.context, previous.current].filter(Boolean).join('\n')}, control.signal, setNotice);
            if (control.signal.aborted) return;
            const followup = !!previous.current;
            previous.current = reply.action === 'answer' ? [previous.current, message, reply.answer].filter(Boolean).join('\n').slice(-3500) : '';
            apply(followup ? reply : {...reply, brief: undefined}, message);
        } catch (err) {
            if (!control.signal.aborted) setNotice(err instanceof Error ? err.message : t('cowork_panels.failed_try', 'That did not work. Try again.'));
        } finally {
            request.current = null;
            if (!control.signal.aborted) setBusy(false);
        }
    }
    const pick = (task: Candidate) => visit(task, choices?.question);
    return {apply, submit, choices, pick, notice, surface, busy, responses};
}

export default function CoworkBeeInput(props: Props) {
    const { t } = useTranslation();
    const {text, edit, inputRef, error, destinations} = props;
    const {apply, submit, choices, pick, notice, surface, busy, responses} = useBeeHome(props);
    const routeIncoming = useEffectEvent(apply);
    useEffect(() => {
        const action = props.seed?.takeAction?.();
        if (props.seed && action) routeIncoming({action}, props.seed.text);
    }, [props.seed]);
    const label = t('cowork_task.orb.talk', 'Ask Bee…');
    return <div className="cowork-bee-dialog">
        {!destinations?.embedded && <div className="cowork-welcome-orb"><CoworkOrb tone={busy ? 'thinking' : 'rest'} /></div>}
        {choices && <div className="cowork-bee-options">
            {choices.tasks.length === 0 && <p role="status">{t('cowork_home.tasks.empty', 'No tasks yet. Write one sentence above to start.')}</p>}
            {choices.tasks.map(task => <button type="button" key={task.id} className={LINK_INLINE} onClick={() => pick(task)}>
                {task.title}<small>{task.sharedBy ? t('cowork_home.shared.sees', 'From {owner} · you can see it', {owner: task.sharedBy}) : choiceDetail(task, choices.tasks, t) || whenLine(task, t)}</small>
            </button>)}
        </div>}
        {surface && destinations?.[surface]}
        {(error || notice) && <p role="status">{error || notice}</p>}
        {responses.length > 0 && <div className="cowork-answer-options">{responses.map(value =>
            <button type="button" key={value} disabled={busy} onClick={() => void submit(value)}>{value}</button>)}</div>}
        <div className="cowork-conversation"><form onSubmit={event => { event.preventDefault(); void submit(); }}>
            <textarea ref={inputRef} rows={1} maxLength={4000} readOnly={busy} id="cowork-brief" data-testid="cowork-brief-input" aria-label={label} placeholder={label}
                value={text} onChange={event => edit(event.target.value)} onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
                }} />
            <button type="submit" className="cowork-chat-send" disabled={busy || !text.trim()} aria-label={t('cowork_task.orb.send', 'Send message')}><ArrowUp size={18}/></button>
        </form></div>
    </div>;
}
