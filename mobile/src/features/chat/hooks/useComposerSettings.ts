/**
 * The direct-chat composer's settings, split by lifetime, not by screen.
 *
 * `modelTier` and `webSearchEnabled` are a standing preference and live in
 * the persisted store — as plain state, every new chat silently reset them and
 * someone who had deliberately switched web search off got it back on without
 * being told.
 *
 * `knowledgeBaseIds` belong to THIS conversation, and the server keeps them
 * (PATCH /ai/direct/conversations/:id, the web's saveAttachedKnowledgeBases):
 * a saved chat opens grounded on what it was grounded on, and a change is
 * saved as it is made — or undone, with the reason, when the server refuses.
 * A new chat holds its choice locally and sends it with the first turn.
 *
 * `reasoningEffort` is per question and never remembered: a stored "high"
 * would quietly spend the user's allowance on every trivial question after it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useKnowledgeBases } from '@/features/knowledge';

import { CHOICE_LIST_STALE_MS, useTiers } from './queries';
import { saveConversationKnowledgeBases } from '../api/endpoints';
import { kbRefusalOf, sameSelection, type KbRefusal } from '../model/kbSelection';
import { setChatPreferences, useChatPreferences } from '../model/settingsStore';
import { reconcileTier, type TierMap } from '../model/tiers';
import type { ComposerSettings, ReasoningEffort } from '../model/types';

const NO_TIERS: TierMap = {};
const NO_BASES: { id: string; name: string }[] = [];

/**
 * Tell the composer which saved conversation it is on, and what the server
 * has attached to it. Run by the screen once the conversation has loaded; the
 * server's selection is taken once per conversation, before any local change.
 */
export function useConversationGrounding(
    ground: (id: string | null, serverIds?: string[]) => void,
    id: string | null,
    serverIds: string[] | undefined,
): void {
    useEffect(() => ground(id, serverIds), [ground, id, serverIds]);
}

/**
 * `kb` seeds a new chat's knowledge bases, comma-separated: "Ask about this"
 * routes with one `?kb=`, the home composer with whatever it had attached.
 */
export function useComposerSettings(kb?: string) {
    const prefs = useChatPreferences();
    const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(null);
    const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>(() => (kb ? kb.split(',').filter(Boolean) : []));
    const [kbRefusal, setKbRefusal] = useState<KbRefusal | null>(null);
    const [kbSaving, setKbSaving] = useState(false);
    const conversationId = useRef<string | null>(null);
    const restored = useRef<string | null>(null);
    const ground = useCallback((id: string | null, serverIds?: string[]) => {
        conversationId.current = id;
        if (!id || !serverIds || restored.current === id) return;
        restored.current = id;
        setKnowledgeBaseIds(serverIds);
    }, []);

    const persistBases = useCallback(
        (next: string[], previous: string[]) => {
            const id = conversationId.current;
            if (!id || sameSelection(next, previous)) return;
            setKbSaving(true);
            setKbRefusal(null);
            saveConversationKnowledgeBases(id, next)
                // What the server STORED — deduplicated and re-authorised — is what the chips show.
                .then((stored) => setKnowledgeBaseIds(stored))
                .catch((err: unknown) => {
                    setKnowledgeBaseIds(previous);
                    setKbRefusal(kbRefusalOf(err));
                })
                .finally(() => setKbSaving(false));
        },
        [],
    );

    // Memoised because the send path depends on it, and a transcript of
    // markdown should not rebuild on every keystroke in the composer.
    const settings: ComposerSettings = useMemo(
        () => ({ modelTier: prefs.modelTier, webSearchEnabled: prefs.webSearchEnabled, reasoningEffort, knowledgeBaseIds }),
        [prefs.modelTier, prefs.webSearchEnabled, reasoningEffort, knowledgeBaseIds],
    );
    const onSettingsChange = useCallback(
        (next: ComposerSettings) => {
            setReasoningEffort(next.reasoningEffort);
            setKnowledgeBaseIds(next.knowledgeBaseIds);
            persistBases(next.knowledgeBaseIds, settings.knowledgeBaseIds);
            setChatPreferences({ modelTier: next.modelTier, webSearchEnabled: next.webSearchEnabled });
        },
        [persistBases, settings.knowledgeBaseIds],
    );

    const tiers = useTiers('direct_chat');
    // A remembered tier can vanish between sessions — a beta flag switched
    // off, a group changed, a custom tier deleted — and sending one the server
    // will not accept fails the turn with an error the user cannot act on.
    useEffect(() => {
        if (!tiers.data || !prefs.ready) return;
        const resolved = reconcileTier(prefs.modelTier, tiers.data);
        if (resolved !== prefs.modelTier) setChatPreferences({ modelTier: resolved });
    }, [tiers.data, prefs.modelTier, prefs.ready]);

    // Names for the attached chips, fetched only once something is attached.
    const bases = useKnowledgeBases({ enabled: knowledgeBaseIds.length > 0, staleTime: CHOICE_LIST_STALE_MS });

    return {
        settings,
        onSettingsChange,
        tiers: tiers.data ?? NO_TIERS,
        knowledgeBaseNames: bases.data ?? NO_BASES,
        kbRefusal,
        kbSaving,
        ground,
    };
}
