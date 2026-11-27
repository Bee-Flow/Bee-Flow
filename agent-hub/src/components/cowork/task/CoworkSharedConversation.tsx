import { useEffect, useEffectEvent, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useCoworkConversation, type CoworkMessage, type CoworkReply } from '@/api/coworkProposals';
import type { CoworkItem } from '@/api/cowork.types';
import { useTakePendingQuestion } from '../usePendingBeeDraft';
import { whenLine } from '../coworkOverviewModel';
import { administersOrg } from '../coworkViewer';
import { teamworkRequest } from '../coworkTeamworkRequest';
import type { CoworkSheetPanelProps } from '../coworkSheetPanels';
import { LINK_INLINE } from '../coworkUi';
import { TaskMessageInput, ConversationHistory } from './CoworkOrbComposer';
import useOrbDestinations from './useOrbDestinations';
import { Failure } from './taskUi';

type SharedView = 'result' | 'history';
interface Props {
    takeQuestion?: () => string;
    user: CoworkSheetPanelProps['user']; itemId: string; item?: CoworkItem; loading: boolean; fillComposer: CoworkSheetPanelProps['fillComposer']; open: CoworkSheetPanelProps['open']; show: (view: SharedView) => void;
}

/** Only unambiguous commands bypass the read-only conversation. Questions about content go to Bee. */
function sharedShortcut(message: string) {
    const command = message.toLocaleLowerCase().replace(/[?!.]+$/, '');
    if (/^(?:verwijder|wis|delete|remove|pause|pauzeer) (?:deze taak|de taak|this task|the task)$/.test(command)) return 'access';
    if (/^(?:open|toon|bekijk|show|view) (?:de |het |the )?(?:history|eerdere uitvoeringen|geschiedenis|previous runs)$/.test(command)) return 'history';
    if (/^(?:open|toon|bekijk|show|view) (?:de |het |the )?(?:output|result(?:s|aat|aten)?)$/.test(command)) return 'result';
    if (/^(?:when does (?:this task|it) run|wanneer draait (?:deze taak|dit)|hoe vaak draait deze taak)$/.test(command)) return 'schedule';
    return null;
}

function openReply(reply: CoworkReply, message: string, {show, open, fillComposer}: Pick<Props, 'show' | 'open' | 'fillComposer'>) {
    switch (reply.action) {
        case 'result': case 'history': return show(reply.action);
        case 'teamwork': return open(teamworkRequest(message, undefined, true) ?? {kind: 'teamwork'});
        case 'attention': return fillComposer('', 'attention');
        case 'shared_tasks': return fillComposer('', 'shared');
        case 'new_task': return fillComposer(message, 'create');
        case 'preferences': return open({kind: 'settings', section: reply.section});
        case 'templates': case 'org': return open({kind: reply.action, section: reply.section});
    }
}

export default function CoworkSharedConversation({itemId, item, user, loading, open, show, fillComposer, takeQuestion}: Props) {
    const {t} = useTranslation();
    const [text, setText] = useState('');
    const [queued, setQueued] = useState('');
    const [messages, setMessages] = useState<CoworkMessage[]>([]);
    const takePendingQuestion = useTakePendingQuestion();
    const dialog = useCoworkConversation(itemId);
    const destinations = useOrbDestinations(() => {}, (id, shared) => open({kind: shared ? 'shared' : 'task', id}), t);
    function submit(incoming?: string, preserveDraft = false) {
        const message = (incoming ?? text).trim();
        if (!message || dialog.isPending) return;
        if (loading) {
            setQueued(message);
            setText('');
            return;
        }
        if (queued === message) setQueued('');
        if (!item) return fillComposer(message, 'ask');
        const question: CoworkMessage = {role: 'user', text: message};
        const answer = (reply: string) => setMessages(previous => [...previous, question, {role: 'assistant', text: reply}]);
        if (!preserveDraft) setText('');
        destinations.clear();
        const desk = teamworkRequest(message);
        if (desk) return open(desk);
        switch (sharedShortcut(message)) {
            case 'history': return show('history');
            case 'result': return show('result');
            case 'schedule': return answer(whenLine(item, t));
            case 'access': return answer(t('cowork_task.shared.owner_only', 'Only the owner can change this shared task.'));
        }
        setMessages(previous => [...previous, question]);
        dialog.mutate({view:'shared', message, history: messages.slice(-6)}, {
            onSuccess: reply => {
                if (reply.action === 'org' && !administersOrg(user)) {
                    setMessages(previous => [...previous, {role: 'assistant', text: t('cowork_panels.org.not_admin', 'Only administrators of your organisation can see and change these rules.')}]);
                    return;
                }
                const line = reply.ownerOnly ? t('cowork_task.shared.owner_only', 'Only the owner can change this shared task.') : destinations.receive(reply);
                setMessages(previous => [...previous, {role:'assistant', text:line}]);
                if (!reply.ownerOnly) openReply(reply, message, {show, open, fillComposer});
            },
            onError: () => setText(current => current || message),
        });
    }
    const sendIncoming = useEffectEvent((message: string) => submit(message, true));
    useEffect(() => {
        if (loading || dialog.isPending) return;
        const incoming = queued || takePendingQuestion() || takeQuestion?.();
        if (incoming) sendIncoming(incoming);
    }, [takeQuestion, takePendingQuestion, dialog.isPending, loading, queued]);
    const transcript = dialog.partial ? [...messages, {role:'assistant' as const, text:dialog.partial}] : messages;
    return <div className="cowork-conversation">
        <div className="cowork-chat-context">
            {item && <ConversationHistory messages={transcript}/>}
            {item && destinations.tasks.length > 0 && <div className="cowork-bee-options">{destinations.tasks.map(task =>
                <button type="button" key={task.id} className={LINK_INLINE} onClick={() => destinations.openTask(task.id, task.shared)}>
                    {task.title}<small>{task.detail}</small>
                </button>)}</div>}
            {queued && <p role="status">{t('cowork_home.dialog.queued', 'I’ll take this up with your task in a moment.')}</p>}
            <Failure error={dialog.error} t={t}/>
        </div>
        <TaskMessageInput text={text} setText={setText} send={submit} busy={!!queued || dialog.isPending}/>
    </div>;
}
