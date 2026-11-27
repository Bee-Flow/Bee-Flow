import { useLayoutEffect, useRef } from 'react';
import { TaskMessageInput } from './TaskMessageInput';
export { TaskMessageInput } from './TaskMessageInput';
import MarkdownRenderer from '@/components/renderers/MarkdownRenderer';
import { useTranslation } from '@/hooks/useTranslation';
import type { TaskConversation } from './useTaskConversation';
import { cadenceLine } from '../coworkSchedule';
import { BUTTON_PRIMARY, LINK_INLINE } from '../coworkUi';
import { Failure } from './taskUi';

function ClockReview({ clock }: {clock: TaskConversation['clock']}) {
    const { t } = useTranslation();
    if (!clock.schedule) return null;
    return <div className="cowork-chat-reply">
        <p role="status">{cadenceLine(clock.schedule, t)} · {clock.schedule.timezone}</p>
        <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={BUTTON_PRIMARY} disabled={clock.disabled} onClick={clock.confirm}>{t('cowork_task.orb.apply_clock', 'Apply schedule')}</button>
            <button type="button" className={LINK_INLINE} disabled={clock.disabled} onClick={clock.cancel}>{t('cowork_task.edit.cancel', 'Cancel')}</button>
        </div>
    </div>;
}

export function ConversationHistory({ messages }: Pick<TaskConversation, 'messages'>) {
    const { t } = useTranslation();
    const log = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    useLayoutEffect(() => {
        const box = log.current;
        if (!box) return;
        if (messages.at(-1)?.role === 'user') following.current = true;
        const follow = () => { if (following.current) box.scrollTop = box.scrollHeight; };
        follow();
        if (typeof ResizeObserver === 'undefined') return;
        const resize = new ResizeObserver(follow);
        resize.observe(box);
        if (box.firstElementChild) resize.observe(box.firstElementChild);
        return () => resize.disconnect();
    }, [messages]);
    if (!messages.length) return null;
    return <div ref={log} className="cowork-transcript" role="log" aria-label={t('cowork_task.history.heading', 'History')}
        onScroll={e => {
            const box = e.currentTarget;
            following.current = box.scrollHeight - box.clientHeight - box.scrollTop < 24;
        }}>
        <div className="cowork-transcript-lines">{messages.map((message, index) => (
            <div key={index} className={'cowork-turn cowork-turn-' + message.role}>
                {message.role === 'user' ? message.text : <MarkdownRenderer content={message.text} />}
            </div>
        ))}</div>
    </div>;
}

export default function CoworkOrbComposer({ chat }: { chat: TaskConversation }) {
    const { t } = useTranslation();
    return <div className="cowork-conversation">
        <div className="cowork-chat-context">
            <ConversationHistory messages={chat.messages} />
            {chat.responses.length > 0 && <div className="cowork-answer-options">
                {chat.responses.map(value => <button type="button" key={value} onClick={() => chat.send(value)}>{value}</button>)}
            </div>}
            <ClockReview clock={chat.clock} />
            <Failure error={chat.error} t={t} />
            {chat.selected.length > 100 && <p role="alert">{t('cowork_task.orb.shorten', 'Select fewer steps or shorten the change.')}</p>}
        </div>
        <TaskMessageInput text={chat.text} setText={chat.setText} send={chat.send} busy={chat.dialog.isPending || chat.selected.length > 100} />
    </div>;
}
