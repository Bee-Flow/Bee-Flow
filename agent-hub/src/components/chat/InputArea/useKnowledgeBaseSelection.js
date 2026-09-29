/**
 * WHICH knowledge bases this chat is grounded on, and how a change to that is
 * committed.
 *
 * The composer renders the claim; this hook holds it. Three things live here
 * and they belong together:
 *
 *   the CLAIM      — resolveKbClaim() narrowed to what the server returned,
 *                    `null` while GET /api/kb has not answered;
 *   the COMMIT     — a PATCH whose ANSWER, not the click, moves the checkbox;
 *   the REFUSAL    — stored with the conversation it happened in, so switching
 *                    chats drops it without an effect having to clear it.
 *
 * `showKBPicker` itself stays with the composer, because the pill owns it (see
 * ComposerPills.jsx) — the hook is only handed the current value and the
 * setter, for the outside-click listener that closes the panel.
 *
 * The hook calls are in the order they had inside InputArea; they were lifted
 * as one contiguous block, and keeping that order is what makes the lift a
 * move rather than a rewrite.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { saveAttachedKnowledgeBases } from '../conversationKbApi';
import { MAX_ATTACHED_KBS, resolveKbClaim } from '../knowledgeBaseClaim';

export default function useKnowledgeBaseSelection({
    availableKBs,
    selectedKBIds,
    onChangeKBIds,
    directConversationId,
    showKBPicker,
    setShowKBPicker,
    kbPickerSearch,
}) {
    const kbPickerRef = useRef(null);

    useEffect(() => {
        if (!showKBPicker) return;
        const onClick = (e) => {
            if (kbPickerRef.current && !kbPickerRef.current.contains(e.target)) {
                setShowKBPicker(false);
            }
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, [showKBPicker, setShowKBPicker]);

    /**
     * What this chat is grounded on, as far as it can be substantiated — null
     * when GET /api/kb has not answered, and otherwise the selection narrowed
     * to what the server just returned. See knowledgeBaseClaim.js; the whole
     * decision lives there so it can be reasoned about without a composer
     * around it.
     *
     * The offered list is filtered on `usage_contexts` here rather than by
     * narrowing the fetch, because that ONE list also feeds the Knowledge
     * store — a management screen, which has to show everything the person
     * manages, chat-usable or not.
     */
    const kbClaim = useMemo(
        () => resolveKbClaim({ availableKBs, selectedKBIds }),
        [availableKBs, selectedKBIds],
    );

    // In flight, and the last refusal — a change that did not land has to say
    // so, because the picker deliberately does not tick the box until the
    // server confirms it, and silence there would read as "it saved".
    //
    // The refusal is stored WITH the conversation it happened in, so switching
    // chats drops it without an effect having to clear it: a warning about a
    // chat you are no longer in is its own small lie.
    const [kbSaving, setKbSaving] = useState(false);
    const [kbFailure, setKbFailure] = useState(null);
    const kbError = kbFailure && kbFailure.convId === directConversationId ? kbFailure.reason : null;
    const setKbError = useCallback(
        (reason) => setKbFailure(reason ? { reason, convId: directConversationId } : null),
        [directConversationId],
    );
    // Only the newest request may write: two quick clicks otherwise finish out
    // of order and the older answer wins, putting a stale list on screen with
    // the server holding a different one.
    const kbCommitSeq = useRef(0);

    /**
     * Attach exactly `next`, then show WHAT THE SERVER STORED — not `next`.
     *
     * The PATCH answers with the effective list (deduplicated, trimmed,
     * re-authorised), a rejection stores nothing at all, and both outcomes are
     * things the composer must not paper over: an optimistic tick would claim
     * a base the following turn does not search.
     *
     * A chat with no id yet has nothing to persist to — the conversation is
     * created by the first turn, which carries `knowledgeBaseIds` with it — so
     * there the selection is simply held locally.
     */
    const commitKBIds = useCallback(async (next) => {
        if (typeof onChangeKBIds !== 'function') return;
        setKbError(null);
        if (next.length > MAX_ATTACHED_KBS) { setKbError('too_many'); return; }
        if (!directConversationId) { onChangeKBIds(next); return; }
        const seq = ++kbCommitSeq.current;
        setKbSaving(true);
        const result = await saveAttachedKnowledgeBases(directConversationId, next);
        if (kbCommitSeq.current !== seq) return;
        setKbSaving(false);
        if (result.ok) { onChangeKBIds(result.knowledgeBaseIds); return; }
        setKbError(result.reason);
    }, [onChangeKBIds, directConversationId, setKbError]);

    const kbPickerOptions = useMemo(() => {
        const options = kbClaim ? kbClaim.options : [];
        const q = kbPickerSearch.trim().toLowerCase();
        if (!q) return options;
        return options.filter(kb => (kb.name || '').toLowerCase().includes(q)
            || (kb.description || '').toLowerCase().includes(q));
    }, [kbClaim, kbPickerSearch]);

    return { kbPickerRef, kbClaim, kbSaving, kbError, commitKBIds, kbPickerOptions };
}
