import { useEffect, useEffectEvent, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useCoworkConversation, type CoworkMessage } from '@/api/coworkProposals';
import type { CoworkItem } from '@/api/cowork.types';
import { whenLine } from '../coworkOverviewModel';
import { teamworkRequest } from '../coworkTeamworkRequest';
import type { CoworkSheetPanelProps } from '../coworkSheetPanels';
import { LINK_INLINE } from '../coworkUi';
import { TaskMessageInput, ConversationHistory } from './CoworkOrbComposer';
import useOrbDestinations from './useOrbDestinations';
import { Failure } from './taskUi';

type SharedView = 'result' | 'history';
interface Props {
    takeQuestion?: () => string;
    item: CoworkItem; fillComposer: CoworkSheetPanelProps['fillComposer']; open: CoworkSheetPanelProps['open']; show: (view: SharedView) => void;
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

export default function CoworkSharedConversation({item, open, show, fillComposer, takeQuestion}: Props) {
    const {t} = useTranslation();
    const [text, setText] = useState('');
    const [messages, setMessages] = useState<CoworkMessage[]>([]);
    const dialog = useCoworkConversation(item.id);
    const destinations = useOrbDestinations(() => {}, (id, shared) => open({kind: shared ? 'shared' : 'task', id}), t);
    function submit(incoming?: string) {
        const message = (incoming ?? text).trim();
        if (!message || dialog.isPending) return;
        const question: CoworkMessage = {role: 'user', text: message};
        const answer = (reply: string) => setMessages(previous => [...previous, question, {role: 'assistant', text: reply}]);
        setText('');
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
                const line = reply.ownerOnly ? t('cowork_task.shared.owner_only', 'Only the owner can change this shared task.') : destinations.receive(reply);
                setMessages(previous => [...previous, {role:'assistant', text:line}]);
                switch (reply.action) {
                    case 'result': case 'history': return show(reply.action);
                    case 'teamwork': return open(teamworkRequest(message, undefined, true) ?? {kind:'teamwork'});
                    case 'attention': return fillComposer('', 'attention');
                    case 'shared_tasks': return fillComposer('', 'shared');
                    case 'new_task': return fillComposer(message, 'create');
                }
            },
            onError: () => setText(current => current || message),
        });
    }
    const sendIncoming = useEffectEvent(submit);
    useEffect(() => {
        const incoming = takeQuestion?.();
        if (incoming) sendIncoming(incoming);
    }, [takeQuestion]);
    const transcript = dialog.partial ? [...messages, {role:'assistant' as const, text:dialog.partial}] : messages;
    return <div className="cowork-conversation">
        <ConversationHistory messages={transcript}/>
        {destinations.tasks.map(task => <button key={task.id} className={LINK_INLINE} onClick={() => destinations.openTask(task.id, task.shared)}>{task.title}</button>)}
        <Failure error={dialog.error} t={t}/>
        <TaskMessageInput text={text} setText={setText} send={submit} busy={dialog.isPending}/>
    </div>;
}
