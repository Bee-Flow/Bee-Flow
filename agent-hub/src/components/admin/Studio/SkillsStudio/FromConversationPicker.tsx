import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import Modal from '@/components/shared/Modal';
import { toast } from '@/components/shared/Toast';
import { skillsApi } from '@/api/skillsApi';
import type { JsonResourceError } from '@/api/client';
import type { FromConversationPickerProps, PickerConversation, PickerMessage, BusyProps } from './ExamplesTab.types';

export function FromConversationPicker({ skillId, onClose, onAdded, t }: FromConversationPickerProps) {
    const [conversations, setConversations] = useState<PickerConversation[] | false | null>(null);
    const [conversationId, setConversationId] = useState<string | null>(null);
    const [messages, setMessages] = useState<PickerMessage[] | false | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /**
     * Did the personal-data check actually RUN on this conversation?
     *
     * The server answers it per read, because the guard can be missing or
     * down, and both of those come back looking like "nothing found". While
     * it is false the server refuses to copy anything out (503
     * `pii_unchecked`), so the promise below is withdrawn rather than left
     * standing over text nothing looked at. `true` until told otherwise: the
     * sentence is about a read that has happened, not about a spinner.
     */
    const [piiChecked, setPiiChecked] = useState(true);

    useEffect(() => {
        let alive = true;
        skillsApi.exampleConversations()
            .then((body) => { if (alive) setConversations(body?.conversations || []); })
            // `false`, not `[]`: an empty array renders as "No conversations of
            // your own yet.", which is a claim about the account. A read that
            // failed made that claim AND showed the error line at the same
            // time — two contradictory sentences in one panel.
            .catch((e) => { if (alive) { setConversations(false); setError(e.message); } });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        if (!conversationId) return undefined;
        let alive = true;
        setMessages(null);
        // The previous conversation's answer is not this one's. Left standing,
        // conversation A's "personal data is removed" sentence sat over
        // conversation B while B was still loading.
        setPiiChecked(true);
        setError(null);
        skillsApi.exampleMessages(conversationId)
            .then((body) => {
                if (!alive) return;
                setMessages(body?.messages || []);
                // Only an explicit `false` withdraws the promise. An older
                // server that does not send the field has the guard wired the
                // way it always was, and the write is the real gate anyway.
                setPiiChecked(body?.piiChecked !== false);
            })
            // Same rule as the list above, and one more thing: a failed read
            // says nothing about the personal-data check either, so the promise
            // is withdrawn rather than left standing from the PREVIOUS
            // conversation.
            .catch((e) => { if (alive) { setMessages(false); setPiiChecked(false); setError(e.message); } });
        return () => { alive = false; };
    }, [conversationId]);

    /**
     * The server's `code` is what gets translated, not its English sentence.
     * `pii_unchecked` is minted deliberately (503, routes/skills/examples.js)
     * and was then thrown away here: `setError(e.message)` put the raw English
     * server string on a Dutch screen.
     */
    const messageFor = (e: { code?: string | null; message?: string } | null | undefined) => {
        if (e?.code === 'pii_unchecked') {
            return t(
                'skills_studio.examples.err_pii_unchecked',
                'The personal-data check is unavailable, so this answer cannot be copied into an example right now.',
            );
        }
        if (e?.code === 'too_many_examples') {
            return t('skills_studio.examples.err_full', 'This skill already has the maximum number of examples.');
        }
        return e?.message || t('skills_studio.examples.err_take', 'Could not use that message.');
    };

    const take = async (message: PickerMessage) => {
        setBusy(true);
        setError(null);
        try {
            const body = await skillsApi.exampleFromMessage(skillId, {
                conversationId,
                messageIndex: message.index,
            });
            if (body?.example) onAdded(body.example);
            else onClose();
        } catch (e) {
            const text = messageFor(e as JsonResourceError);
            setError(text);
            toast.error(text);
            // A 503 is about the guard, not about this message: the whole list
            // is uncopyable until it is back, and the note above says so.
            if ((e as JsonResourceError)?.code === 'pii_unchecked') setPiiChecked(false);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open
            onClose={onClose}
            title={t('skills_studio.examples.from_chat', 'Pick from a conversation')}
            size="lg"
        >
            <div className="flex flex-col gap-3 min-h-[16rem]">
                <p
                    className="text-xs m-0"
                    style={{ color: piiChecked ? 'var(--text-secondary)' : 'var(--warning)' }}
                    data-testid="skill-example-pii-note"
                    role={piiChecked ? undefined : 'status'}
                >
                    {piiChecked
                        ? t(
                            'skills_studio.examples.from_chat_help',
                            'Only your own conversations are listed. Personal data is removed before the example is stored.',
                        )
                        : t(
                            'skills_studio.examples.from_chat_unchecked',
                            'Only your own conversations are listed. The personal-data check is unavailable right now, so nothing here can be copied into an example until it is back.',
                        )}
                </p>
                {error && <p className="text-xs m-0 text-[var(--error)]" role="status">{error}</p>}

                {!conversationId && (
                    <ul className="list-none p-0 m-0 flex flex-col gap-1 overflow-y-auto max-h-[22rem]">
                        {conversations === null && <Busy t={t} />}
                        {conversations === false && (
                            <li className="text-xs py-4 [color:var(--warning-ink,var(--warning))]!">
                                {t('skills_studio.examples.conversations_unreadable', 'Your conversations could not be read just now, so none are listed. That is not “you have none”.')}
                            </li>
                        )}
                        {conversations !== false && conversations?.length === 0 && (
                            <li className="text-xs text-[var(--text-tertiary)] py-4">
                                {t('skills_studio.examples.no_conversations', 'No conversations of your own yet.')}
                            </li>
                        )}
                        {(conversations || []).map((conv) => (
                            <li key={conv.id}>
                                <button
                                    type="button"
                                    onClick={() => setConversationId(conv.id)}
                                    data-testid="skill-example-conversation"
                                    className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-[var(--bg-secondary)] transition"
                                >
                                    <span className="block text-[var(--text-primary)] truncate">{conv.title || t('skills_studio.examples.untitled_chat', 'Untitled conversation')}</span>
                                    {conv.agentName && <span className="block text-[var(--text-tertiary)] truncate">{conv.agentName}</span>}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}

                {conversationId && (
                    <>
                        <button
                            type="button"
                            onClick={() => { setConversationId(null); setMessages(null); }}
                            className="self-start text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline"
                        >
                            {t('skills_studio.examples.back_to_chats', 'Back to conversations')}
                        </button>
                        <ul className="list-none p-0 m-0 flex flex-col gap-1 overflow-y-auto max-h-[22rem]">
                            {messages === null && <Busy t={t} />}
                            {messages === false && (
                                <li className="text-xs py-4 [color:var(--warning-ink,var(--warning))]!">
                                    {t('skills_studio.examples.messages_unreadable', 'This conversation could not be read just now. That is not “there is nothing in it”.')}
                                </li>
                            )}
                            {messages !== false && messages?.length === 0 && (
                                <li className="text-xs text-[var(--text-tertiary)] py-4">
                                    {t('skills_studio.examples.no_messages', 'Nothing in this conversation to use.')}
                                </li>
                            )}
                            {(messages || []).filter((m) => m.role === 'assistant').map((message) => (
                                <li key={message.index}>
                                    <button
                                        type="button"
                                        // The warning above already says nothing
                                        // here can be copied; leaving the rows
                                        // clickable made the person wait for a
                                        // round trip to be told again.
                                        disabled={busy || !piiChecked}
                                        onClick={() => take(message)}
                                        data-testid="skill-example-message"
                                        className="w-full text-left px-3 py-2 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition disabled:opacity-50"
                                    >
                                        {message.text}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>
        </Modal>
    );
}

function Busy({ t }: BusyProps) {
    return (
        <li className="flex items-center gap-2 text-xs text-[var(--text-tertiary)] py-4">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            {t('skills_studio.examples.loading', 'Loading…')}
        </li>
    );
}
