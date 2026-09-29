import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, RefObject, SetStateAction } from 'react';
import useModelTierSelection from '../../../hooks/useModelTierSelection';
import type { ModelTierMap } from '../../../hooks/useModelTierSelection';
import useStickToBottom from '../../../hooks/useStickToBottom';
import scopedStorage from '../../../utils/scopedStorage';

export interface BuilderChatPanel {
    assistantOpen: boolean;
    setAssistantOpen: Dispatch<SetStateAction<boolean>>;
    chatWidth: number;
    onChatResizeStart: (e: ReactMouseEvent<HTMLElement>) => void;
    chatInput: string;
    setChatInput: Dispatch<SetStateAction<string>>;
    modelTiers: ModelTierMap;
    selectedTier: string;
    /** The tier the next send actually goes on — the host's pin wins. */
    tierForSend: string;
    /** A no-op while the host pins the tier: the picker shows it, and cannot persist a change. */
    setTierForPicker: (tier: string) => void;
    messagesContainerRef: RefObject<HTMLDivElement | null>;
    messagesBodyRef: RefObject<HTMLDivElement | null>;
    messagesEndRef: RefObject<HTMLDivElement | null>;
    onMessagesScroll: () => void;
    stickMessages: () => void;
}

export interface UseBuilderChatPanelOptions {
    /** A hosted mount that opens the assistant for the user — never persisted. */
    forceAssistantOpen?: boolean;
    initialChatInput?: string;
    /** A tier the host pins for every send of this mount. */
    forcedTier?: string | null;
    /** A turn is in flight, so the transcript should follow it down. */
    running?: boolean;
}

/**
 * The assistant column: whether it is open, how wide the user dragged it,
 * what is typed in it, which tier that will be sent on, and keeping the
 * transcript pinned to the bottom while a turn is running. All of it is the
 * user's own choice, so all of it is persisted per user.
 *
 * A hosted mount (`forceAssistantOpen`) is not a choice and is not persisted.
 */
export default function useBuilderChatPanel({
    forceAssistantOpen, initialChatInput, forcedTier, running,
}: UseBuilderChatPanelOptions): BuilderChatPanel {
    // The AI assistant is a summonable, right-docked panel — the canvas is
    // full-width by default (assistant closed). Persisted so the choice
    // survives reload.
    const [assistantOpen, setAssistantOpen] = useState(() => forceAssistantOpen || scopedStorage.getItem('routinesAssistantOpen') === '1');
    useEffect(() => {
        if (forceAssistantOpen) return;   // a hosted mount is not the user's choice
        scopedStorage.setItem('routinesAssistantOpen', assistantOpen ? '1' : '0');
    }, [assistantOpen, forceAssistantOpen]);

    // Resizable chat column — drag the gutter between chat and diagram.
    // Persisted so the user's chosen width survives reloads. Bounds match
    // AgentWizard/BuilderSplit's resize handle (240–600px).
    const [chatWidth, setChatWidth] = useState(() => {
        const raw = parseInt(scopedStorage.getItem('routinesChatWidth') || '', 10);
        // 320 by default (design 1c) — a width the user chose is kept as is.
        return Number.isFinite(raw) && raw >= 240 && raw <= 600 ? raw : 320;
    });
    useEffect(() => {
        scopedStorage.setItem('routinesChatWidth', String(chatWidth));
    }, [chatWidth]);
    const dragStartX = useRef(0);
    const dragStartW = useRef(0);
    const onChatResizeStart = useCallback((e: ReactMouseEvent<HTMLElement>) => {
        dragStartX.current = e.clientX;
        dragStartW.current = chatWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        const onMove = (ev: MouseEvent) => {
            // Gutter is on the RIGHT edge of the left-docked assistant, so
            // dragging right (positive delta) GROWS the panel.
            const delta = ev.clientX - dragStartX.current;
            setChatWidth(Math.min(600, Math.max(240, dragStartW.current + delta)));
        };
        const onUp = () => {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [chatWidth]);

    // ── InputArea state (mirrors direct chat) ────────────────────────────
    const [chatInput, setChatInput] = useState(initialChatInput || '');
    // taskType 'automation' (C27): the AI-step tier dropdown was fed the
    // direct-chat list, offering Flow/Swarm — tiers execAiStep silently
    // degrades to one plain chat call (and now refuses at run time).
    const { modelTiers, selectedTier, setSelectedTier } = useModelTierSelection({ storageKey: 'automationBuilderTier', taskType: 'automation' });
    // A host may pin the tier (a Playbook builds on Fast explicitly — `auto`
    // floors the small local model away and adds a classification round per
    // turn); the picker then shows the pinned tier and cannot persist a change.
    const tierForSend = forcedTier || selectedTier || 'auto';
    const setTierForPicker = forcedTier ? () => {} : setSelectedTier;

    // Re-seed when the parent passes a new example prompt — only when the
    // input is currently empty so we don't clobber what the user is typing.
    const seedChatInput = useEffectEvent(() => {
        if (initialChatInput && !chatInput) setChatInput(initialChatInput);
    });
    useEffect(() => { seedChatInput(); }, [initialChatInput]);

    // Follow the build while the reader is at the bottom. Keyed on
    // `messages.length` this only moved on a NEW message, so a step being
    // added to the turn already on screen scrolled out of sight; the hook
    // watches the list box instead (owner, 2026-09-16).
    const messagesContainerRef = useRef<HTMLDivElement | null>(null);
    const messagesBodyRef = useRef<HTMLDivElement | null>(null);
    const messagesEndRef = useRef<HTMLDivElement | null>(null);
    const { onScroll: onMessagesScroll, forceStick: stickMessages } = useStickToBottom({
        containerRef: messagesContainerRef, contentRef: messagesBodyRef,
    });
    useEffect(() => { if (running) stickMessages(); }, [running, stickMessages]);

    return {
        assistantOpen, setAssistantOpen,
        chatWidth, onChatResizeStart,
        chatInput, setChatInput,
        modelTiers, selectedTier, tierForSend, setTierForPicker,
        messagesContainerRef, messagesBodyRef, messagesEndRef,
        onMessagesScroll, stickMessages,
    };
}
