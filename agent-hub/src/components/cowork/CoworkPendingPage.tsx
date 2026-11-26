import { useContext, useState, type ReactNode } from 'react';
import CoworkOrb from './CoworkOrb';
import { PendingBeeDraft } from './usePendingBeeDraft';
import { TaskMessageInput } from './task/TaskMessageInput';
import { LINK_INLINE } from './coworkUi';
import { useTranslation } from '@/hooks/useTranslation';

interface Props {
    message: string;
    ask?: (message: string) => void;
    waitForTask?: boolean;
    retry?: () => void;
    children?: ReactNode;
}

export default function CoworkPendingPage({message, ask, retry, waitForTask, children}: Props) {
    const {t} = useTranslation();
    const draft = useContext(PendingBeeDraft);
    const [text, setText] = useState(draft?.read().text || (!waitForTask && draft?.read().question) || '');
    const [queued, setQueued] = useState(Boolean(waitForTask && draft?.read().question));
    return <div className="cowork-pending-page">
        <CoworkOrb tone={retry ? 'rest' : 'thinking'} />
        <p role={retry ? 'alert' : 'status'}>{message}</p>
        {retry && <button type="button" className={LINK_INLINE} onClick={retry}>{t('cowork_task.retry', 'Try again')}</button>}
        {children}
        {queued && <p role="status">{t('cowork_home.dialog.queued', 'I’ll take this up with your task in a moment.')}</p>}
        {ask && <div className="cowork-conversation" onFocusCapture={() => { draft?.update({focused: true}); }}
            onBlurCapture={() => { draft?.update({focused: false}); }}>
            <PendingBeeDraft.Provider value={null}>
                <TaskMessageInput text={text} busy={queued} setText={value => {
                    const next = typeof value === 'function' ? value(text) : value;
                    draft?.update({text: next});
                    setText(next);
                }} send={() => {
                    const message = text.trim();
                    draft?.update({text: ''});
                    setText('');
                    if (waitForTask && draft) {
                        draft.update({question: message});
                        setQueued(true);
                    } else ask(message);
                }} />
            </PendingBeeDraft.Provider>
        </div>}
    </div>;
}
