import { Loader2, MessageSquarePlus, Plus, Trash2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import { toast } from '../../../shared/Toast';
import { newLocalId } from './skillModel';
import { skillsApi } from './skillsApi';

/**
 * "Examples" — what a good answer looks like (Skills artboard 1b).
 *
 * Each card is question → good answer (+ why it is good) and, optionally,
 * "Not like this" with the rule it breaks. The bad half is opt-in on
 * purpose: a wrong answer in the prompt is a thing the model has now READ,
 * so it earns its place only when the agent keeps getting one specific
 * thing wrong. The card only asks for it once the good half exists.
 *
 * ── "PICK FROM A CONVERSATION" ──────────────────────────────────────
 * The real source of a good example is an answer that already happened.
 * Two rules make that safe, and both live on the server (routes/skills/
 * examples.js), not here:
 *   - the conversation must be the CALLER'S OWN. `getConversationById` has
 *     no owner filter, so an id from someone else's chat would otherwise
 *     read out their conversation — an IDOR. The route checks `user_id`.
 *   - the text is read with `{restore: false}` (Privacy Shield tokens stay
 *     tokens) and scanned again before it is stored, which is what the
 *     artboard's "personal data is removed automatically" promises.
 * `sourceConversationId` is kept as PROVENANCE only. It is never rendered
 * as a link: the example may be read by colleagues who cannot open that
 * chat, and a link that 404s for half its readers is worse than none.
 */
export default function ExamplesTab({ skillId, examples, rules = [], onChange, readOnly = false }) {
    const { t } = useTranslation();
    const rows = Array.isArray(examples) ? examples : [];
    const [picking, setPicking] = useState(false);

    const patch = (id, next) => onChange(rows.map(e => (e.id === id ? { ...e, ...next } : e)));
    const remove = (id) => onChange(rows.filter(e => e.id !== id));
    const add = () => onChange([...rows, {
        id: newLocalId('ex'), question: '', good: '', rationale: '', bad: '', violatedRuleId: '', sourceConversationId: '',
    }]);

    return (
        <div className="flex flex-col gap-3" data-testid="skill-examples">
            <div className="flex items-start gap-3">
                <p className="text-xs text-[var(--text-secondary)] m-0 flex-1">
                    {t(
                        'skills_studio.examples.intro',
                        'Examples show what it should look like. Two or three good ones are enough; a bad one helps with things the agent keeps getting wrong.',
                    )}
                </p>
                {!readOnly && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                            type="button"
                            onClick={() => setPicking(true)}
                            data-testid="skill-example-from-chat"
                            className="h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-xs font-medium text-[var(--text-primary)] inline-flex items-center gap-1.5"
                        >
                            <MessageSquarePlus size={13} aria-hidden="true" />
                            {t('skills_studio.examples.from_chat', 'Pick from a conversation')}
                        </button>
                        <button
                            type="button"
                            onClick={add}
                            data-testid="skill-example-add"
                            className="h-8 px-3 rounded-[10px] text-xs font-semibold inline-flex items-center gap-1.5"
                            style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
                        >
                            <Plus size={13} aria-hidden="true" />
                            {t('skills_studio.examples.add', 'Example')}
                        </button>
                    </div>
                )}
            </div>

            {rows.length === 0 && (
                <p className="text-xs text-[var(--text-tertiary)] italic m-0">
                    {t('skills_studio.examples.empty', 'No examples yet.')}
                </p>
            )}

            {rows.map((example) => (
                <ExampleCard
                    key={example.id}
                    example={example}
                    rules={rules}
                    readOnly={readOnly}
                    onPatch={(next) => patch(example.id, next)}
                    onRemove={() => remove(example.id)}
                    t={t}
                />
            ))}

            {/* The artboard's standing hint (1b, bottom): the best examples are
                made where the good answer happened, not typed here afterwards.
                It names the button DIRECTLY ABOVE it. The artboard's own copy
                pointed at a Chat action ("Make an example for skill…") that
                does not exist anywhere in the app — a hint that sends someone
                looking for a menu item nobody built is worse than no hint. */}
            <p
                className="flex items-center gap-2.5 px-3.5 py-3 rounded-xl border border-dashed border-[var(--border-default)] text-xs m-0"
                style={{ color: 'var(--text-secondary)' }}
                data-testid="skill-examples-chat-hint"
            >
                <MessageSquarePlus size={14} aria-hidden="true" className="flex-shrink-0" />
                {t(
                    'skills_studio.examples.chat_hint',
                    'The best examples come from an answer that already happened — “Pick from a conversation” above brings one in, with personal data removed automatically.',
                )}
            </p>

            {picking && (
                <FromConversationPicker
                    skillId={skillId}
                    onClose={() => setPicking(false)}
                    onAdded={(example) => { setPicking(false); onChange([...rows, example]); }}
                    t={t}
                />
            )}
        </div>
    );
}

const CAP_LABEL = 'text-[10px] tracking-[.08em] uppercase font-semibold';

/**
 * One example card.
 *
 * ── A RULE THAT WAS DELETED ─────────────────────────────────────────
 * The rule an example points at can be removed in the Rules tab, and rule
 * ids are stable (skillStructure mints one per rule and keeps it), so the
 * reference simply stops resolving. A `<select>` with no option carrying its
 * own value shows the FIRST one instead — so the card read "No specific
 * rule" while `violatedRuleId` still held the dead id, and kept saving that
 * id on every write. `orphanRule` gives the dead reference an option of its
 * own: the screen and the data then say the same thing, and picking anything
 * else replaces it. Clearing it here instead would be an edit nobody asked
 * for, fired by a render — the mistake `bad: ' '` already made once below.
 */
function ExampleCard({ example, rules, readOnly, onPatch, onRemove, t }) {
    /**
     * Opening the "Not like this" half is a VIEW state, not data. It used to
     * be written as `bad: ' '`, which reads as stored but is not: the server
     * keeps `bad` only when it is non-blank (skillStructure.validateExamples
     * uses `trim()`), so the space was dropped and the half silently closed
     * again on the next load. Local state says the same thing honestly, and
     * has the better behaviour besides — opening a field is not an edit, so
     * it fires no autosave.
     */
    const [revealed, setRevealed] = useState(false);
    const showBad = revealed || !!example.bad || !!example.violatedRuleId;
    // A `violatedRuleId` whose rule no longer exists — see the select below.
    const orphanRule = !!example.violatedRuleId && !rules.some(r => r.id === example.violatedRuleId);
    return (
        <article
            data-testid="skill-example"
            data-example-id={example.id}
            className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] shadow-sm p-4 grid gap-3"
            style={{ gridTemplateColumns: showBad ? '1fr 1fr 1fr' : '1fr 1fr' }}
        >
            <Field
                label={t('skills_studio.examples.question', 'When someone asks')}
                labelColor="var(--text-tertiary)"
                value={example.question}
                readOnly={readOnly}
                onChange={(question) => onPatch({ question })}
                surface
            />
            <div className="flex flex-col gap-1.5">
                <Field
                    label={t('skills_studio.examples.good', 'Good answer')}
                    labelColor="var(--success-ink)"
                    borderColor="var(--success)"
                    value={example.good}
                    readOnly={readOnly}
                    onChange={(good) => onPatch({ good })}
                />
                <input
                    value={example.rationale}
                    readOnly={readOnly}
                    onChange={(e) => onPatch({ rationale: e.target.value })}
                    aria-label={t('skills_studio.examples.rationale', 'Why this is good')}
                    placeholder={t('skills_studio.examples.rationale', 'Why this is good')}
                    className="bg-transparent outline-none text-xs text-[var(--text-tertiary)] placeholder:text-[var(--text-tertiary)]"
                />
            </div>
            {showBad ? (
                <div className="flex flex-col gap-1.5">
                    <Field
                        label={t('skills_studio.examples.bad', 'Not like this')}
                        labelColor="var(--error-ink)"
                        borderColor="var(--error)"
                        value={example.bad}
                        readOnly={readOnly}
                        onChange={(bad) => onPatch({ bad })}
                    />
                    <select
                        value={example.violatedRuleId || ''}
                        disabled={readOnly}
                        onChange={(e) => onPatch({ violatedRuleId: e.target.value })}
                        aria-label={t('skills_studio.examples.violates', 'Rule it breaks')}
                        data-testid="skill-example-violates"
                        className="bg-transparent outline-none text-xs text-[var(--text-tertiary)]"
                    >
                        <option value="">{t('skills_studio.examples.no_rule', 'No specific rule')}</option>
                        {/* The rule this example named was deleted — see above. */}
                        {orphanRule && (
                            <option value={example.violatedRuleId}>
                                {t('skills_studio.examples.rule_gone', 'The rule this broke was removed')}
                            </option>
                        )}
                        {rules.map((rule) => (
                            <option key={rule.id} value={rule.id}>
                                {rule.text || rule.id}
                            </option>
                        ))}
                    </select>
                </div>
            ) : (
                !readOnly && (
                    <button
                        type="button"
                        onClick={() => setRevealed(true)}
                        data-testid="skill-example-add-bad"
                        className="self-start text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline decoration-dotted col-span-2 text-left"
                    >
                        {t('skills_studio.examples.add_bad', 'Add an answer to avoid')}
                    </button>
                )
            )}
            <div className="col-span-full flex items-center gap-3">
                {/* PROVENANCE, and nothing more. This line used to say
                    "Taken from one of YOUR conversations · personal data
                    removed" off nothing but the presence of the id — and that
                    id is client input: `PUT /api/skills/:id` takes `examplesV2`
                    straight from the body (skillStructure keeps
                    `sourceConversationId` as a 128-char string), and nothing on
                    that path is scanned. So a hand-typed example with any id in
                    it wore a guarantee no guard had ever made. The picker's own
                    promise is withdrawn honestly when the check did not run
                    (`piiChecked`); this one could not see that at all.
                    "your" was the second untruth: the example is read by every
                    colleague the skill is shared with, and it was not their
                    conversation.

                    A NEW key rather than new English on the old one:
                    `examples.from_conversation` is already in en-defaults.js
                    with the old sentence, and `t()` answers from the ladder —
                    the inline fallback is only reached for a key that is
                    MISSING. Rewriting the fallback would have left the untrue
                    sentence on screen until the ladder caught up, which for a
                    promise about personal data is the wrong way round.
                    `examples.from_conversation` is now unused; it is reported
                    for removal with the rest. */}
                {example.sourceConversationId && (
                    <span className="text-xs text-[var(--text-tertiary)]" data-testid="skill-example-source">
                        {t('skills_studio.examples.source_note', 'Taken from a conversation')}
                    </span>
                )}
                {!readOnly && (
                    <button
                        type="button"
                        onClick={onRemove}
                        aria-label={t('skills_studio.examples.remove', 'Remove example')}
                        className="ml-auto p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] transition"
                    >
                        <Trash2 size={13} aria-hidden="true" />
                    </button>
                )}
            </div>
        </article>
    );
}

function Field({ label, labelColor, borderColor, value, readOnly, onChange, surface = false }) {
    return (
        <label className="flex flex-col gap-1.5 min-w-0">
            <span className={CAP_LABEL} style={{ color: labelColor }}>{label}</span>
            <textarea
                value={value}
                readOnly={readOnly}
                rows={3}
                onChange={(e) => onChange(e.target.value)}
                className="w-full resize-y rounded-lg px-3 py-2 text-xs leading-[17px] outline-none text-[var(--text-primary)]"
                style={{
                    background: surface ? 'var(--bg-secondary)' : 'transparent',
                    border: `1px solid ${borderColor || 'var(--border-default)'}`,
                }}
            />
        </label>
    );
}

/**
 * The conversation → message picker. Both reads go through the skills
 * router, which is where the "your own conversation only" check lives; this
 * component never touches the agents API, so there is exactly one owner
 * check to get right instead of two.
 */
function FromConversationPicker({ skillId, onClose, onAdded, t }) {
    const [conversations, setConversations] = useState(null);
    const [conversationId, setConversationId] = useState(null);
    const [messages, setMessages] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
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
    const messageFor = (e) => {
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

    const take = async (message) => {
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
            const text = messageFor(e);
            setError(text);
            toast.error(text);
            // A 503 is about the guard, not about this message: the whole list
            // is uncopyable until it is back, and the note above says so.
            if (e?.code === 'pii_unchecked') setPiiChecked(false);
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
                {error && <p className="text-xs m-0" style={{ color: 'var(--error)' }} role="status">{error}</p>}

                {!conversationId && (
                    <ul className="list-none p-0 m-0 flex flex-col gap-1 overflow-y-auto max-h-[22rem]">
                        {conversations === null && <Busy t={t} />}
                        {conversations === false && (
                            <li className="text-xs py-4" style={{ color: 'var(--warning-ink, var(--warning))' }}>
                                {t('skills_studio.examples.conversations_unreadable', 'Your conversations could not be read just now, so none are listed. That is not “you have none”.')}
                            </li>
                        )}
                        {conversations?.length === 0 && (
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
                                <li className="text-xs py-4" style={{ color: 'var(--warning-ink, var(--warning))' }}>
                                    {t('skills_studio.examples.messages_unreadable', 'This conversation could not be read just now. That is not “there is nothing in it”.')}
                                </li>
                            )}
                            {messages?.length === 0 && (
                                <li className="text-xs text-[var(--text-tertiary)] py-4">
                                    {t('skills_studio.examples.no_messages', 'Nothing in this conversation to use.')}
                                </li>
                            )}
                            {(messages || []).filter(m => m.role === 'assistant').map((message) => (
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

function Busy({ t }) {
    return (
        <li className="flex items-center gap-2 text-xs text-[var(--text-tertiary)] py-4">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            {t('skills_studio.examples.loading', 'Loading…')}
        </li>
    );
}
