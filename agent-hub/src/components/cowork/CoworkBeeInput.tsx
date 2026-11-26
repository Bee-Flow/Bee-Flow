import { useState, type RefObject } from 'react';
import { ArrowUp } from 'lucide-react';
import type { CoworkItem } from '@/api/cowork.types';
import { useTranslation } from '@/hooks/useTranslation';
import CoworkOrb from './CoworkOrb';
import { useExistingTaskAction } from './CoworkExistingTasks';
import { whenLine } from './coworkOverviewModel';
import { LINK_INLINE } from './coworkUi';

interface Props {
    text: string;
    edit: (value: string) => void;
    go: () => void;
    inputRef: RefObject<HTMLTextAreaElement | null>;
    items: CoworkItem[];
    ask?: (id: string, text: string) => void;
    open?: (id: string) => void;
    error?: string | null;
    atLimit: boolean;
}

const listRequest = /^(?:(?:toon|bekijk|open|show|list|view)\s+)?(?:(?:al|alle|all|mijn|my|de|the|bestaande|existing)\s+)*(?:taken|tasks|werk)\s*[?.!]?$/i;
const discovery = /^(?:welke|wat voor|which|what)\b.*\b(?:taken|tasks)\b.*(?:heb ik|zijn er|do i have|are there|available)\b/i;

function requestsTaskList(message: string) {
    return listRequest.test(message) || discovery.test(message);
}

export default function CoworkBeeInput({text, edit, go, inputRef, items, ask, open, error, atLimit}: Props) {
    const { t } = useTranslation();
    const [choices, setChoices] = useState<CoworkItem[] | null>(null);
    const [question, setQuestion] = useState('');
    const [notice, setNotice] = useState('');
    const action = useExistingTaskAction(items, text, ask);
    const submit = () => {
        const message = text.trim();
        if (!message) return;
        const navigate = /^open\s/i.test(message) || items.some(item => item.title.toLowerCase() === message.toLowerCase());
        setNotice('');
        if (requestsTaskList(message)) {
            setQuestion('');
            setChoices(items);
        } else if (action.matches.length && (action.editing || /\?$|^(open|waarom|why|hoe|how)\b/i.test(message) || navigate)) {
            if (action.matches.length === 1) {
                edit('');
                if (navigate) open?.(action.matches[0].id);
                else action.open(action.matches[0]);
                return;
            }
            setQuestion(navigate ? '' : message);
            setChoices(action.matches);
        } else if (/^(?:hoi|hallo|hey|hello|hi|help|wat kun je|wat kan je|what can you do)[!?. ]*$/i.test(message) || /^(?:wat|welke|waarom|hoe|which|what|why|how)\b/i.test(message)) {
            setChoices(null);
            setNotice(t('cowork_home.dialog.help', 'Describe a new task, ask to see your tasks, or mention a task by name.'));
        } else if (atLimit) {
            setNotice(t('cowork_home.at_limit', 'You have {count} tasks, the most you can have. Delete one to add another.', {count: items.length}));
            return;
        } else {
            go();
            return;
        }
        edit('');
    };
    const label = t('cowork_task.orb.talk', 'Ask Bee…');
    return <div className="cowork-bee-dialog">
        <div className="cowork-welcome-orb"><CoworkOrb tone="rest" /></div>
        {choices && <div className="cowork-bee-options">
            {choices.length === 0 && <p role="status">{t('cowork_task.orb.no_work', 'I couldn’t find another matching task. Try a different name.')}</p>}
            {choices.map(task => <button type="button" key={task.id} className={LINK_INLINE} onClick={() => question ? ask?.(task.id, question) : open?.(task.id)}>
                {task.title}<small>{whenLine(task, t)}</small>
            </button>)}
        </div>}
        {(error || notice) && <p role="status">{error || notice}</p>}
        <div className="cowork-conversation"><form onSubmit={event => { event.preventDefault(); submit(); }}>
            <textarea ref={inputRef} rows={1} id="cowork-brief" data-testid="cowork-brief-input" aria-label={label} placeholder={label}
                value={text} onChange={event => { setChoices(null); setNotice(''); edit(event.target.value); }} onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
                }} />
            <button type="submit" className="cowork-chat-send" disabled={!text.trim()} aria-label={t('cowork_task.orb.send', 'Send message')}><ArrowUp size={18}/></button>
        </form></div>
    </div>;
}
