/**
 * The voice session: minted on connect, refreshed once it is older than the
 * server's stated lifetime. The history is deliberately NOT cleared on a
 * refresh — the server holds no state, so a new session id costs nothing and
 * the conversation continues.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { createSession, type CreateSessionInput } from '../api/endpoints';
import type { VoiceSession } from '../model/types';

export function useVoiceSessionKeeper(options: CreateSessionInput) {
    const [session, setSession] = useState<VoiceSession | null>(null);
    const current = useRef<VoiceSession | null>(null);
    const mintedAt = useRef(0);
    const optionsRef = useRef(options);
    useEffect(() => {
        optionsRef.current = options;
    }, [options]);

    /** Mint a fresh session. Throws what createSession throws. */
    const startSession = useCallback(async (): Promise<VoiceSession> => {
        const next = await createSession(optionsRef.current);
        current.current = next;
        mintedAt.current = Date.now();
        setSession(next);
        return next;
    }, []);

    /** The live session, or a fresh one when it has outlived its lifetime. */
    const ensureSession = useCallback(async (): Promise<VoiceSession> => {
        const live = current.current;
        if (live && Date.now() - mintedAt.current < live.sessionTimeoutMs) return live;
        return startSession();
    }, [startSession]);

    return { session, startSession, ensureSession };
}
