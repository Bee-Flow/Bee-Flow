// The message box of a team chat. Enter sends, Shift+Enter adds a line, `@`
// opens a menu of the people in the project and the AI; "Ask AI" sends and
// asks the AI to answer even when nobody mentions it.

import { Bot, BookOpen, CheckSquare, CornerUpLeft, FileText, Mic, SendHorizontal, Sparkles, X } from 'lucide-react';
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TeamChatRef } from '../../../../api/queries/projectChatTypes';
import { useTranslation } from '../../../../hooks/useTranslation';
import TierSlider from '../../../licensing/TierSlider';
import { ComposerShell } from '../../../shared/ComposerBox';
import { CHAT_COLUMN_CLASS } from './chatColumn';
import { readDraft, writeDraft } from './drafts';
import { isImeEnter, isImeKey } from './ime';
import type { ChatTier } from './useChatTier';
import { Avatar, PrimaryButton, SecondaryButton } from '../workspaceUi';
import {
    findMentionQuery, insertMention, matchCandidates, mentions, resolveMentions, type MentionCandidate, type MentionQuery,
} from './mentions';

export const MAX_MESSAGE_LENGTH = 20_000;

export interface ComposerDraft { content: string; mentions: string[]; refs: TeamChatRef[]; askAi: boolean; modelTier?: string }

export interface ChatComposerProps {
    candidates: MentionCandidate[];
    /** False when the chat's AI mode is off: nothing would answer. */
    aiEnabled: boolean;
    reply: { author: string; excerpt: string } | null;
    onCancelReply: () => void;
    /** The response depth the AI is asked for; absent hides the control. */
    tier?: ChatTier | null;
    /** Overrides the placeholder, e.g. inside a thread. */
    placeholder?: string;
    onSend: (draft: ComposerDraft) => void;
    onTyping: () => void;
    /** Keeps the unsent text (and the picked mentions) under this key while the composer is away. */
    draftKey?: string;
    /** ArrowUp in an empty composer: edit your latest message. */
    onEditLastOwn?: () => void;
    /** Text dropped in from outside (an empty chat's starter chips); `nonce` makes each drop fresh. */
    prefill?: { text: string; nonce: number } | null;
}

function useMentionMenu(candidates: MentionCandidate[]) {
    const [query, setQuery] = useState<MentionQuery | null>(null);
    const [active, setActive] = useState(0);
    const matches = useMemo(() => (query ? matchCandidates(candidates, query.query) : []), [candidates, query]);
    return {
        query,
        matches,
        active: Math.min(active, Math.max(0, matches.length - 1)),
        open: !!query && matches.length > 0,
        setActive,
        update: (text: string, caret: number) => { setQuery(findMentionQuery(text, caret)); setActive(0); },
        // The caret moved without the text changing (arrows, Home/End, a click):
        // the word under it is a different one, or none. Keeps the highlighted row when nothing changed.
        sync: (text: string, caret: number) => {
            const next = findMentionQuery(text, caret);
            if (next?.start === query?.start && next?.query === query?.query) return;
            setQuery(next);
            setActive(0);
        },
        close: () => setQuery(null),
    };
}

type MentionMenuState = ReturnType<typeof useMentionMenu>;

/** Arrow keys move, Enter or Tab picks, Escape closes. True when the key was the menu's. */
function menuKey(e: React.KeyboardEvent, menu: MentionMenuState, pick: (c: MentionCandidate) => void): boolean {
    if (isImeKey(e)) return false;
    const n = menu.matches.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        menu.setActive((menu.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
        pick(menu.matches[menu.active]);
    } else if (e.key === 'Escape') {
        menu.close();
    } else {
        return false;
    }
    e.preventDefault();
    return true;
}

function CandidateIcon({ candidate }: { candidate: MentionCandidate }) {
    if (candidate.kind === 'user') return <Avatar name={candidate.label} size="sm" picture={candidate.picture} />;
    const Icon = candidate.kind === 'agent' ? Bot : candidate.kind === 'document' ? FileText : candidate.kind === 'notebook' ? BookOpen : candidate.kind === 'meeting' ? Mic : candidate.kind === 'task' ? CheckSquare : Sparkles;
    return (
        <span className="inline-grid place-items-center w-6 h-6 rounded-full bg-[var(--item-active-bg)] text-[var(--accent-primary)]" aria-hidden="true">
            <Icon className="w-3.5 h-3.5" />
        </span>
    );
}

function MentionMenu({ id, menu, onPick }: { id: string; menu: MentionMenuState; onPick: (c: MentionCandidate) => void }) {
    const { t } = useTranslation();
    return (
        <ul role="listbox" id={id} aria-label={t('project_chat.mention_menu', 'Mention someone')}
            className="absolute bottom-full left-2 mb-1 w-72 max-h-64 overflow-y-auto custom-scrollbar list-none m-0 p-1 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-lg z-20">
            {menu.matches.map((c, i) => (
                <li key={c.key} id={`${id}-${i}`} role="option" aria-selected={i === menu.active}
                    onMouseDown={e => e.preventDefault()} onClick={() => onPick(c)} onMouseEnter={() => menu.setActive(i)}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-[13px] text-[var(--text-primary)] ${i === menu.active ? 'bg-[var(--item-active-bg)]' : ''}`}>
                    <CandidateIcon candidate={c} />
                    <span className="truncate flex-1">{c.label}</span>
                    {(c.kind === 'ai' || c.kind === 'agent') && <span className="text-[11px] text-[var(--text-tertiary)]">{t('project_chat.mention_ai_hint', 'answers here')}</span>}
                    {c.kind === 'document' && <span className="text-[11px] text-[var(--text-tertiary)]">{t('project_chat.mention_document_hint', 'document')}</span>}
                    {c.kind === 'notebook' && <span className="text-[11px] text-[var(--text-tertiary)]">{t('project_chat.mention_notebook_hint', 'notebook')}</span>}
                    {c.kind === 'meeting' && <span className="text-[11px] text-[var(--text-tertiary)]">{t('project_chat.mention_meeting_hint', 'meeting')}</span>}
                    {c.kind === 'task' && <span className="text-[11px] text-[var(--text-tertiary)]">{t('project_chat.mention_task_hint', 'task')}</span>}
                </li>
            ))}
        </ul>
    );
}

function ReplyChip({ reply, onCancel }: { reply: { author: string; excerpt: string }; onCancel: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2 px-3 pt-2 text-[12px] text-[var(--text-secondary)] min-w-0" data-testid="team-chat-reply-chip">
            <CornerUpLeft className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            <span className="flex-shrink-0">{t('project_chat.replying_to', 'Replying to {name}', { name: reply.author })}</span>
            <span className="truncate">{reply.excerpt}</span>
            <button type="button" onClick={onCancel} aria-label={t('project_chat.cancel_reply', 'Cancel reply')}
                className="ml-auto grid place-items-center w-6 h-6 rounded-md hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]">
                <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
        </div>
    );
}

function useComposerState(props: ChatComposerProps) {
    const { draftKey } = props;
    const [text, setTextState] = useState(() => readDraft(draftKey)?.text ?? '');
    const picked = useRef<MentionCandidate[]>(readDraft(draftKey)?.picked ?? []);
    const setText = (next: string) => {
        setTextState(next);
        writeDraft(draftKey, { text: next, picked: picked.current });
    };
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const nextCaret = useRef<number | null>(null);
    const menu = useMentionMenu(props.candidates);
    const candidatesRef = useRef(props.candidates);
    candidatesRef.current = props.candidates;

    // A starter chip drops its text (and the mentions it names, so @ai really asks) into the box.
    const prefill = props.prefill;
    useEffect(() => {
        if (!prefill) return;
        picked.current = candidatesRef.current.filter(c => mentions(prefill.text, c.token));
        setText(prefill.text);
        inputRef.current?.focus();
    }, [prefill]);

    useLayoutEffect(() => {
        const el = inputRef.current;
        if (!el || nextCaret.current === null) return;
        el.focus();
        el.setSelectionRange(nextCaret.current, nextCaret.current);
        nextCaret.current = null;
    }, [text]);

    const pick = (candidate: MentionCandidate) => {
        if (!menu.query) return;
        const caret = inputRef.current?.selectionStart ?? text.length;
        const next = insertMention(text, menu.query, caret, candidate.token);
        picked.current = [...picked.current.filter(p => p.key !== candidate.key), candidate];
        nextCaret.current = next.caret;
        setText(next.text);
        menu.close();
    };
    const submit = (askAi: boolean) => {
        const content = text.trim();
        if (!content) return;
        const { userIds, refs, asksAi } = resolveMentions(content, picked.current);
        props.onSend({ content, mentions: userIds, refs, askAi: askAi || asksAi, ...(props.tier ? { modelTier: props.tier.value } : {}) });
        picked.current = [];
        setText('');
        menu.close();
        inputRef.current?.focus();
    };
    const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        setText(value);
        menu.update(value, e.target.selectionStart ?? value.length);
        if (value.trim()) props.onTyping();
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (menu.open && menuKey(e, menu, pick)) return;
        if (e.key === 'Enter' && !e.shiftKey && !isImeEnter(e)) {
            e.preventDefault();
            submit(false);
        } else if (e.key === 'ArrowUp' && !text.trim() && props.onEditLastOwn) {
            e.preventDefault();
            props.onEditLastOwn();
        } else if (e.key === 'Escape' && props.reply) {
            e.preventDefault();
            props.onCancelReply();
        }
    };
    const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
        const el = e.currentTarget;
        if (menu.query) menu.sync(el.value, el.selectionStart ?? el.value.length);
    };
    return { text, inputRef, menu, pick, submit, onChange, onKeyDown, onSelect };
}

export default function ChatComposer(props: ChatComposerProps) {
    const { t } = useTranslation();
    const menuId = useId();
    const s = useComposerState(props);
    const empty = !s.text.trim();
    return (
        <div className="flex-shrink-0 px-4 pb-4">
            <ComposerShell compact label={t('project_chat.composer_label', 'Message the team')} className={CHAT_COLUMN_CLASS}>
                {props.reply && <ReplyChip reply={props.reply} onCancel={props.onCancelReply} />}
                {s.menu.open && <MentionMenu id={menuId} menu={s.menu} onPick={s.pick} />}
                <textarea
                    ref={s.inputRef}
                    value={s.text}
                    onChange={s.onChange}
                    onKeyDown={s.onKeyDown}
                    onSelect={s.onSelect}
                    onBlur={() => s.menu.close()}
                    maxLength={MAX_MESSAGE_LENGTH}
                    rows={Math.min(8, Math.max(2, s.text.split('\n').length))}
                    aria-label={t('project_chat.message_label', 'Message')}
                    aria-autocomplete="list"
                    aria-controls={s.menu.open ? menuId : undefined}
                    aria-activedescendant={s.menu.open ? `${menuId}-${s.menu.active}` : undefined}
                    placeholder={props.placeholder || t('project_chat.composer_placeholder', 'Message the team. Type @ to tag people, tasks, documents and more.')}
                    className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13.5px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
                />
                <div className="flex items-center gap-2 px-2 pb-2">
                    <span className="flex-1 min-w-0 truncate pl-1 text-[11px] text-[var(--text-secondary)]">
                        {t('project_chat.composer_hint', 'Enter to send, Shift+Enter for a new line')}
                    </span>
                    {props.tier && props.aiEnabled && (
                        <TierSlider tiers={props.tier.tiers} value={props.tier.value} onChange={props.tier.onChange} variant="input" />
                    )}
                    <SecondaryButton onClick={() => s.submit(true)} disabled={empty || !props.aiEnabled}
                        title={props.aiEnabled ? t('project_chat.ask_ai_hint', 'Send and ask the AI to answer') : t('project_chat.ai_is_off', 'The AI is off in this chat')}>
                        <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />{t('project_chat.ask_ai', 'Ask AI')}
                    </SecondaryButton>
                    <PrimaryButton onClick={() => s.submit(false)} disabled={empty} aria-label={t('project_chat.send', 'Send')} title={t('project_chat.send', 'Send')}>
                        <SendHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
                    </PrimaryButton>
                </div>
            </ComposerShell>
        </div>
    );
}
