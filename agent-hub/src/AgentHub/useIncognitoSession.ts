import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { incognitoAllowsTier, newIncognitoSessionId } from '@/components/chat/incognito/incognitoChat';
import type { CoworkMode } from '@/components/cowork/CoworkModeSwitch';
import type { TurnIncognito } from '@/hooks/useChatEngine/turnRequest';
import type { ChatMessage } from '@/hooks/useChatEngine/types';

/**
 * One incognito session of the hub's chat: on from the toggle of a new, empty
 * chat until that chat stops being the active one. Never stored anywhere (no
 * URL, no storage), so a reload always comes back as a normal empty chat, and
 * never sticky: the next new chat starts in normal mode.
 *
 * `endIncognito` reports whether a session was on, so a caller can clear the
 * messages that belonged to it and nothing else.
 */
export default function useIncognitoSession() {
    const [session, setSession] = useState<TurnIncognito | null>(null);
    // Mirrors `session` synchronously. The paths that end a session (a
    // navigation handler, then an unmount in the same commit) run before the
    // next render, and the second must see that the first already ended it.
    const sessionRef = useRef<TurnIncognito | null>(null);
    const apply = useCallback((next: TurnIncognito | null) => {
        sessionRef.current = next;
        setSession(next);
    }, []);
    const setIncognito = useCallback((on: boolean) => {
        // A fresh id per session: the agent route keys its ephemeral turn on it.
        apply(on ? { sessionId: newIncognitoSessionId() } : null);
    }, [apply]);
    const endIncognito = useCallback((): boolean => {
        if (!sessionRef.current) return false;
        apply(null);
        return true;
    }, [apply]);
    return { incognitoSession: session, setIncognito, endIncognito };
}

interface IncognitoControlsArgs {
    endIncognito: () => boolean;
    setIncognitoSession: (on: boolean) => void;
    /** The engine's raw setter. */
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    /** The engine's stop: an incognito answer still streaming has nowhere to land. */
    stopGenerating: () => void;
    setCoworkMode: (mode: CoworkMode) => void;
    selectedTier: string;
    setSelectedTier: (tier: string) => void;
}

/**
 * How an incognito chat ends, and how it starts.
 *
 * Both end paths also stop a reply that is still streaming: it belonged to the
 * incognito chat, and there is nowhere left for it to land.
 *
 * `replaceMessages`: everything outside the engine that writes the messages
 * REPLACES the conversation on screen (a new chat, another conversation or
 * agent, a notification's "open in chat", the startup restore). The hub hands
 * those paths this setter, so leaving the incognito chat is what ends it and
 * the next new chat starts in normal mode. The engine's own appends, and the
 * voice turns, keep the raw setter.
 *
 * `leaveIncognito`: the chat view unmounted (Settings, Studio, a project page
 * took its place). An incognito chat is gone, its messages with it; a normal
 * chat is left exactly as it was.
 *
 * `setIncognito`: the toggle of a new chat. Cowork and the Swarm tier produce
 * things that are stored, so turning incognito on puts the composer back on
 * plain chat and a tier incognito offers.
 */
export function useIncognitoControls({
    endIncognito, setIncognitoSession, setMessages, stopGenerating, setCoworkMode, selectedTier, setSelectedTier,
}: IncognitoControlsArgs) {
    const replaceMessages = useCallback<Dispatch<SetStateAction<ChatMessage[]>>>((next) => {
        if (endIncognito()) stopGenerating();
        setMessages(next);
    }, [endIncognito, setMessages, stopGenerating]);
    const leaveIncognito = useCallback(() => {
        if (!endIncognito()) return;
        stopGenerating();
        setMessages([]);
    }, [endIncognito, setMessages, stopGenerating]);
    const setIncognito = useCallback((on: boolean) => {
        if (on) {
            setCoworkMode('chat');
            if (!incognitoAllowsTier(selectedTier)) setSelectedTier('auto');
        }
        setIncognitoSession(on);
    }, [setCoworkMode, selectedTier, setSelectedTier, setIncognitoSession]);
    return { replaceMessages, leaveIncognito, setIncognito };
}

/**
 * Call `onLeave` when the calling component unmounts: the chat view goes away
 * when the hub shows Settings, Studio, a project or the welcome state instead.
 */
export function useLeaveOnUnmount(onLeave: (() => void) | null | undefined): void {
    const ref = useRef(onLeave);
    useEffect(() => { ref.current = onLeave; }, [onLeave]);
    useEffect(() => () => { ref.current?.(); }, []);
}
