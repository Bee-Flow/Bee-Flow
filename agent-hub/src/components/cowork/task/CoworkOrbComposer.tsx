import { ArrowUp, Mic, Square } from 'lucide-react';
import useDictation from '@/components/chat/useDictation';
import MarkdownRenderer from '@/components/renderers/MarkdownRenderer';
import { useTranslation } from '@/hooks/useTranslation';
import type { TaskConversation } from './useTaskConversation';
import { Failure } from './taskUi';

export default function CoworkOrbComposer({ chat }: { chat: TaskConversation }) {
    const { t, locale } = useTranslation();
    const mic = useDictation({ language: locale, onText: words => chat.setText(current => [current.trim(), words].filter(Boolean).join(' ').slice(0, 2000)) });
    const recording = mic.state === 'recording';
    const micLabel = recording ? t('chat.composer.dictate_stop', 'Stop recording and insert the text') : t('chat.composer.dictate_start', 'Dictate — speak your instruction');
    const label = t('cowork_task.orb.talk', 'Ask Bee…');
    const disabled = !chat.text.trim() || chat.dialog.isPending || chat.selected.length > 100 || mic.state !== 'idle';
    return <div className="cowork-conversation">
        {chat.reply && <div aria-live="polite" className="cowork-chat-reply"><MarkdownRenderer content={chat.reply} /></div>}
        <Failure error={chat.error} t={t} />
        {chat.selected.length > 100 && <p role="alert">{t('cowork_task.orb.shorten', 'Select fewer steps or shorten the change.')}</p>}
        <form onSubmit={e => { e.preventDefault(); if (!disabled) chat.send(); }}>
            <textarea rows={1} aria-label={label} placeholder={label} value={chat.text} maxLength={2000}
                onChange={e => chat.setText(e.target.value)} onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!disabled) chat.send(); }
                }} />
            {mic.supported && <button type="button" aria-label={micLabel} title={micLabel} aria-pressed={recording} disabled={mic.state === 'transcribing'} onClick={mic.toggle}>
                {recording ? <Square size={16}/> : <Mic size={17}/>}
            </button>}
            <button className="cowork-chat-send" aria-label={t('cowork_task.orb.send', 'Send message')} disabled={disabled}><ArrowUp size={18}/></button>
        </form>
        {mic.error && <p role="alert">{mic.error}</p>}
    </div>;
}
