// The text box of a comment: a new thread, a reply, or an edit. `@` opens a
// menu of the people in the project and the AI; Ctrl/⌘+Enter sends, Enter
// starts a new line (comments run longer than chat lines), Escape cancels.
// A refused send keeps the text where it was, with the reason under it.

import { Sparkles } from 'lucide-react';
import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import {
    findMentionQuery, insertMention, matchCandidates, resolveMentions, type MentionCandidate, type MentionQuery,
} from '../projects/workspace/chat/mentions';
import { Avatar, ErrorText, PrimaryButton, SecondaryButton } from '../projects/workspace/workspaceUi';

export const COMMENT_MAX = 10_000;

export interface CommentDraft { content: string; mentions: string[]; askAi: boolean }

export interface CommentComposerProps {
    candidates: MentionCandidate[];
    /** Accessible name of the text box. */
    label: string;
    placeholder: string;
    submitLabel: string;
    /** Show "Ask AI" (the thread's AI is not off). */
    aiEnabled: boolean;
    busy?: boolean;
    error?: string | null;
    initialText?: string;
    /**
     * Editing: the user ids the comment mentions already. They stay mentioned
     * while the text still names them, without being picked from the menu again.
     */
    initialMentions?: string[];
    autoFocus?: boolean;
    /** Resolves true when the draft was accepted: the box then empties. */
    onSubmit: (draft: CommentDraft) => Promise<boolean> | boolean;
    onCancel?: () => void;
    testId?: string;
}

function MentionList({ id, items, active, onPick, onHover }: {
    id: string;
    items: MentionCandidate[];
    active: number;
    onPick: (c: MentionCandidate) => void;
    onHover: (i: number) => void;
}) {
    const { t } = useTranslation();
    return (
        <ul role="listbox" id={id} aria-label={t('comments.mention_menu', 'Mention someone')}
            className="absolute top-full left-0 mt-1 w-64 max-h-56 overflow-y-auto list-none m-0 p-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] shadow-lg z-30">
            {items.map((c, i) => (
                <li key={c.key} id={`${id}-${i}`} role="option" aria-selected={i === active}
                    onMouseDown={e => e.preventDefault()} onClick={() => onPick(c)} onMouseEnter={() => onHover(i)}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-[13px] text-[var(--text-primary)] ${i === active ? 'bg-[var(--item-active-bg)]' : ''}`}>
                    {c.kind === 'user'
                        ? <Avatar name={c.label} size="sm" />
                        : <Sparkles className="w-4 h-4 mx-1 text-[var(--accent-primary)]" aria-hidden="true" />}
                    <span className="truncate">{c.label}</span>
                </li>
            ))}
        </ul>
    );
}

/** Arrow keys move through the mention menu, Enter or Tab picks, Escape closes it. True when the key was the menu's. */
interface MenuMoves { count: number; current: number; move: (i: number) => void; pick: () => void; close: () => void }

function menuKey(e: React.KeyboardEvent, { count, current, move, pick, close }: MenuMoves): boolean {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') move((current + (e.key === 'ArrowDown' ? 1 : -1) + count) % count);
    else if (e.key === 'Enter' || e.key === 'Tab') pick();
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else return false;
    e.preventDefault();
    return true;
}

/** The people an edited comment mentions already, as candidates: kept while the text names them. */
function alreadyMentioned({ initialMentions, candidates }: CommentComposerProps): MentionCandidate[] {
    if (!initialMentions?.length) return [];
    return candidates.filter(c => c.kind === 'user' && !!c.userId && initialMentions.includes(c.userId));
}

/** Mentions this screen cannot check against the text (no candidate for them): kept as they were. */
function unknownMentions({ initialMentions, candidates }: CommentComposerProps): string[] {
    return (initialMentions || []).filter(id => !candidates.some(c => c.userId === id));
}

function useComposer(props: CommentComposerProps) {
    const [text, setText] = useState(props.initialText || '');
    const [query, setQuery] = useState<MentionQuery | null>(null);
    const [active, setActive] = useState(0);
    const picked = useRef<MentionCandidate[]>([]);
    const box = useRef<HTMLTextAreaElement>(null);
    const caretAfter = useRef<number | null>(null);
    const matches = useMemo(() => (query ? matchCandidates(props.candidates, query.query, 6) : []), [props.candidates, query]);
    const current = Math.min(active, Math.max(0, matches.length - 1));

    useLayoutEffect(() => {
        if (caretAfter.current === null || !box.current) return;
        box.current.focus();
        box.current.setSelectionRange(caretAfter.current, caretAfter.current);
        caretAfter.current = null;
    }, [text]);

    const pick = (c: MentionCandidate) => {
        if (!query) return;
        const next = insertMention(text, query, box.current?.selectionStart ?? text.length, c.token);
        picked.current = [...picked.current.filter(p => p.key !== c.key), c];
        caretAfter.current = next.caret;
        setText(next.text);
        setQuery(null);
    };
    const submit = async (askAi: boolean) => {
        const content = text.trim();
        if (!content || props.busy) return;
        const { userIds, asksAi } = resolveMentions(content, [...alreadyMentioned(props), ...picked.current]);
        if (await props.onSubmit({ content, mentions: [...new Set([...userIds, ...unknownMentions(props)])], askAi: askAi || asksAi })) {
            setText('');
            picked.current = [];
        }
    };
    const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setText(e.target.value);
        setQuery(findMentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length));
        setActive(0);
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (query && matches.length > 0
            && menuKey(e, { count: matches.length, current, move: setActive, pick: () => pick(matches[current]), close: () => setQuery(null) })) return;
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit(false);
        } else if (e.key === 'Escape' && props.onCancel) {
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
        }
    };
    return {
        text, box, matches, current, menuOpen: !!query && matches.length > 0,
        setActive, pick, submit, onChange, onKeyDown, closeMenu: () => setQuery(null),
    };
}

function ComposerActions({ props, empty, submit }: { props: CommentComposerProps; empty: boolean; submit: (askAi: boolean) => Promise<void> }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-1.5 flex-wrap">
            <PrimaryButton onClick={() => void submit(false)} disabled={empty} busy={props.busy}>{props.submitLabel}</PrimaryButton>
            {props.aiEnabled && (
                <SecondaryButton onClick={() => void submit(true)} disabled={empty || props.busy}
                    title={t('comments.ask_ai_hint', 'Send and ask the AI to answer in this thread')}>
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />{t('comments.ask_ai', 'Ask AI')}
                </SecondaryButton>
            )}
            {props.onCancel && (
                <SecondaryButton onClick={props.onCancel} disabled={props.busy}>{t('comments.cancel', 'Cancel')}</SecondaryButton>
            )}
            <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">{t('comments.send_hint', 'Ctrl+Enter or ⌘+Enter to send')}</span>
        </div>
    );
}

export default function CommentComposer(props: CommentComposerProps) {
    const menuId = useId();
    const c = useComposer(props);
    return (
        <div className="flex flex-col gap-1.5" data-testid={props.testId}>
            <div className="relative">
                <textarea
                    ref={c.box}
                    value={c.text}
                    autoFocus={props.autoFocus}
                    onChange={c.onChange}
                    onKeyDown={c.onKeyDown}
                    onBlur={c.closeMenu}
                    maxLength={COMMENT_MAX}
                    rows={Math.min(8, Math.max(2, c.text.split('\n').length))}
                    aria-label={props.label}
                    aria-autocomplete="list"
                    aria-expanded={c.menuOpen}
                    aria-controls={c.menuOpen ? menuId : undefined}
                    aria-activedescendant={c.menuOpen ? `${menuId}-${c.current}` : undefined}
                    placeholder={props.placeholder}
                    className="block w-full resize-none rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-2.5 py-2 text-[13px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--accent-primary)]"
                />
                {c.menuOpen && <MentionList id={menuId} items={c.matches} active={c.current} onPick={c.pick} onHover={c.setActive} />}
            </div>
            <ErrorText>{props.error}</ErrorText>
            <ComposerActions props={props} empty={!c.text.trim()} submit={c.submit} />
        </div>
    );
}
