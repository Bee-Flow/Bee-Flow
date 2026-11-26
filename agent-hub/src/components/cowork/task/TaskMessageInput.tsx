import type { RefObject } from 'react';
import { ArrowUp, Mic, Square } from 'lucide-react';
import useDictation from '@/components/chat/useDictation';
import { useTranslation } from '@/hooks/useTranslation';
import { usePendingBeeDraft } from '../usePendingBeeDraft';
import type { TaskConversation } from './useTaskConversation';

interface MessageInputProps extends Pick<TaskConversation, 'text' | 'setText'> {
    send: () => void;
    busy?: boolean;
    id?: string;
    testId?: string;
    maxLength?: number;
    inputRef?: RefObject<HTMLTextAreaElement | null>;
}

export function TaskMessageInput({ text, setText, send, busy = false, id, testId, maxLength = 2000, inputRef }: MessageInputProps) {
    const { t, locale } = useTranslation();
    const input = usePendingBeeDraft(setText, inputRef);
    const mic = useDictation({ language: locale, onText: words => setText(current => [current.trim(), words].filter(Boolean).join(' ').slice(0, maxLength)) });
    const recording = mic.state === 'recording';
    const micLabel = recording ? t('chat.composer.dictate_stop', 'Stop recording and insert the text') : t('chat.composer.dictate_start', 'Dictate — speak your instruction');
    const label = t('cowork_task.orb.talk', 'Ask Bee…');
    const disabled = !text.trim() || busy || mic.state !== 'idle';
    return <>
        <form data-dictating={mic.state !== 'idle'} onSubmit={e => { e.preventDefault(); if (!disabled) send(); }}>
            <textarea ref={input} id={id} data-testid={testId} rows={1} aria-label={label} placeholder={label} value={text} maxLength={maxLength}
                onChange={e => setText(e.target.value)} onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!disabled) send(); }
                }} />
            {mic.supported && <button type="button" aria-label={micLabel} title={micLabel} aria-pressed={recording} disabled={mic.state === 'transcribing'} onClick={mic.toggle}>
                {recording ? <Square size={16}/> : <Mic size={17}/>}
            </button>}
            <button className="cowork-chat-send" aria-label={t('cowork_task.orb.send', 'Send message')} disabled={disabled}><ArrowUp size={18}/></button>
        </form>
        {mic.error && <p role="alert">{mic.error}</p>}
    </>;
}
