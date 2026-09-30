/**
 * The AI builder under the preview: its composer settings, how it edits
 * (automatically, or propose first), the chat itself, and the brief a new
 * page was created with — sent once, as the page opens, as on the web.
 */

import { useEffect, useState } from 'react';

import { useTiers, type ComposerSettings } from '@/features/chat';

import { useWebpageChat } from './useWebpageChat';
import { pendingPlan, visibleMessages, type ChatMode } from '../model/chat';
import { takeBrief } from '../model/pendingBrief';

const DEFAULT_SETTINGS: ComposerSettings = {
    // `auto` is the tier the server always offers; the builder collapses
    // `standard` to `fast` itself (webpageChat.js).
    modelTier: 'auto',
    // The page's own knowledge is searched server-side on every turn.
    knowledgeBaseIds: [],
    reasoningEffort: null,
    webSearchEnabled: true,
};

export function useBuilder(pageId: string, stored: Record<string, unknown>[]) {
    const [settings, setSettings] = useState<ComposerSettings>(DEFAULT_SETTINGS);
    const [mode, setMode] = useState<ChatMode>('auto');
    const tiers = useTiers('direct_chat');
    const chat = useWebpageChat({ pageId, stored, modelTier: settings.modelTier, mode });

    // Once, on the first mount for this page: the brief parked by the new-page sheet.
    const { send } = chat;
    useEffect(() => {
        const brief = takeBrief(pageId);
        if (brief) send(brief);
    }, [pageId, send]);

    return {
        chat,
        messages: visibleMessages(chat.entries),
        plan: chat.streaming ? null : pendingPlan(chat.entries),
        settings,
        setSettings,
        mode,
        setMode,
        tiers: tiers.data ?? {},
    };
}

export type Builder = ReturnType<typeof useBuilder>;
