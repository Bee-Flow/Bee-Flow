/**
 * What the direct-chat screen hands its transcript and its composer, derived
 * once and kept stable: the transcript's actions (rate, retry, edit — none
 * while a turn streams) and the composer's extras (the shield's claim, the
 * media gates, apps, dictation, the thread banner, a knowledge base that
 * could not be saved).
 */

import { useRouter } from 'expo-router';
import { useMemo } from 'react';

import { useTranslation } from '@/core/i18n';

import type { TranscriptActions } from './transcriptActions';
import { useMediaGates, useShieldLine } from './useComposerStatus';
import type { ComposerExtras } from '../model/composerExtras';
import { KB_REFUSAL_WORDS, MAX_ATTACHED_KBS, type KbRefusal } from '../model/kbSelection';
import type { TierMap } from '../model/tiers';
import type { ChatMessage } from '../model/types';

export interface ChatSurfaceInput {
    conversationId: string | null;
    streaming: boolean;
    tiers: TierMap;
    conversation: () => readonly ChatMessage[];
    onRetry: (answer: ChatMessage, tier?: string | null) => void;
    onEdit: (question: ChatMessage, text: string) => void;
    kbRefusal: KbRefusal | null;
    /** The conversation is a thread shared into a project; its title heads the banner. */
    thread: { title: string | null } | null;
}

export function useChatSurface(input: ChatSurfaceInput): { actions: TranscriptActions; extras: ComposerExtras } {
    const t = useTranslation();
    const router = useRouter();
    const shield = useShieldLine();
    const mediaGates = useMediaGates();
    const { conversationId, streaming, tiers, conversation, onRetry, onEdit, kbRefusal, thread } = input;

    const actions = useMemo<TranscriptActions>(
        () => ({
            // 'direct', not the server's default of 'agent': the operator
            // dashboard groups feedback on this string.
            feedback: { conversationId, source: 'direct' },
            conversation,
            onRetry: streaming ? undefined : onRetry,
            onEdit: streaming ? undefined : onEdit,
            tiers,
            showSources: true,
        }),
        [conversationId, conversation, streaming, onRetry, onEdit, tiers],
    );

    const threadTitle = thread?.title ?? null;
    const inThread = Boolean(thread);
    const notice = kbRefusal ? t(KB_REFUSAL_WORDS[kbRefusal].i18nKey, KB_REFUSAL_WORDS[kbRefusal].en, { count: MAX_ATTACHED_KBS }) : null;
    const extras = useMemo<ComposerExtras>(
        () => ({
            shield,
            mediaGates,
            apps: true,
            dictation: true,
            thread: inThread ? { title: threadTitle, onExit: () => router.back() } : null,
            notice,
        }),
        [shield, mediaGates, inThread, threadTitle, router, notice],
    );

    return { actions, extras };
}
