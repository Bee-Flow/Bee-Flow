import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, RefObject, SetStateAction } from 'react';
import useModelTierSelection from '@/hooks/useModelTierSelection';
import type { ModelTierMap } from '@/hooks/useModelTierSelection';
import useStickToBottom from '@/hooks/useStickToBottom';
import scopedStorage from '@/utils/scopedStorage';

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
    /**
     * The draft is still empty (emptyDraft.ts). The assistant opens for it —
     * also when the definition only turns out empty once it has loaded — and
     * that is not the person's choice either, so it is not persisted.
     */
    emptyDraft?: boolean;
    initialChatInput?: string;
    /** A tier the host pins for every send of this mount. */
    forcedTier?: string | null;
    /** A turn is in flight, so the transcript should follow it down. */
    running?: boolean;
}

/** Whether the assistant column is open, and who decided it (see the hook below). */
function useAssistantOpen(forceAssistantOpen: boolean | undefined, emptyDraft: boolean | undefined) {
    // The AI assistant is a summonable, docked panel — on an automation that
    // already has steps the canvas is full-width by default (assistant
    // closed). Persisted so the person's own choice survives reload.
    const [storedOpen] = useState(() => scopedStorage.getItem('automationsAssistantOpen') === '1');
    // What the person chose on THIS mount; null until they open or close it.
    const [chosen, setChosen] = useState<boolean | null>(null);
    // An empty draft opens the assistant: "what should happen?" is the first
    // question, and the assistant asks it (owner, 2026-11-04). Latched, so the
    // panel does not close again the moment the first step lands; adjusted
    // during render because the definition of an opened draft loads late.
    const [openedForDraft, setOpenedForDraft] = useState(!!emptyDraft);
    if (emptyDraft && !openedForDraft && chosen === null) setOpenedForDraft(true);
    const assistantOpen = chosen ?? (!!forceAssistantOpen || openedForDraft || storedOpen);
    // A stable setter (the hotkeys and the ask-the-assistant hooks hold it):
    // a functional update reads what is on screen through a ref.
    const shownRef = useRef(assistantOpen);
    useLayoutEffect(() => { shownRef.current = assistantOpen; });
    const setAssistantOpen: Dispatch<SetStateAction<boolean>> = useCallback((next) => {
        setChosen((prev) => (typeof next === 'function' ? next(prev ?? shownRef.current) : next));
    }, []);
    useEffect(() => {
        if (forceAssistantOpen || chosen === null) return;   // a hosted mount, or nobody chose yet
        scopedStorage.setItem('automationsAssistantOpen', chosen ? '1' : '0');
    }, [chosen, forceAssistantOpen]);
    return { assistantOpen, setAssistantOpen };
}

/**
 * The assistant column: whether it is open, how wide the user dragged it,
 * what is typed in it, which tier that will be sent on, and keeping the
 * transcript pinned to the bottom while a turn is running. All of it is the
 * user's own choice, so all of it is persisted per user.
 *
 * A hosted mount (`forceAssistantOpen`) and an empty draft (`emptyDraft`)
 * open the assistant without it being a choice, so neither is persisted: only
 * an open or close by the person on this mount writes the preference.
 */
export default function useBuilderChatPanel({
    forceAssistantOpen, emptyDraft, initialChatInput, forcedTier, running,
}: UseBuilderChatPanelOptions): BuilderChatPanel {
    const { assistantOpen, setAssistantOpen } = useAssistantOpen(forceAssistantOpen, emptyDraft);

    // Resizable chat column — drag the gutter between chat and diagram.
    // Persisted so the user's chosen width survives reloads. Bounds match
    // AgentWizard/BuilderSplit's resize handle (240–600px).
    const [chatWidth, setChatWidth] = useState(() => {
        const raw = parseInt(scopedStorage.getItem('automationsChatWidth') || '', 10);
        // 320 by default (design 1c) — a width the user chose is kept as is.
        return Number.isFinite(raw) && raw >= 240 && raw <= 600 ? raw : 360;
    });
    useEffect(() => {
        scopedStorage.setItem('automationsChatWidth', String(chatWidth));
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
