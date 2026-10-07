import { useCallback, useMemo } from 'react';
import { useAgentChatSignalsGate, useChatSignalsPreference, useSetChatSignalsPreference } from '../../../api/queries/chatSignals';
import type { ChatSignalsTurnSurface } from '../../../hooks/useChatEngine/turnEndpoint';
import useShieldStatus from '../../../hooks/useShieldStatus';
import { noticeFor, payloadFor, type NoticeModel } from './chatSignalsModel';

/**
 * Chat signals for the chat on screen: the notice the composer shows, the
 * person's own "don't count me" switch, and the fields the chat engine adds
 * to a turn on the endpoint the notice describes.
 *
 * Three reads, each only when it can matter: the status (shared with every
 * other privacy claim, polled every 30 s), the agent gate (only in an agent
 * chat whose type the status lists) and the person's preference (only while
 * a notice is up). A failed status reads as unknown, so nothing is announced
 * and no marker is sent, which means the turn is simply not counted.
 */

export interface UseChatSignalsInput {
    user: { id?: unknown } | null | undefined;
    surface: ChatSignalsTurnSurface | null | undefined;
    agentId?: string | null;
}

export interface ChatSignalsState {
    notice: NoticeModel | null;
    /** Throws when the choice could not be saved, so the caller can say so. */
    setCounted: (counted: boolean) => Promise<void>;
    payloadFor: (surface: ChatSignalsTurnSurface) => Record<string, unknown> | null;
}

export default function useChatSignals({ user, surface, agentId = null }: UseChatSignalsInput): ChatSignalsState {
    const { data: status } = useShieldStatus({ enabled: !!user });
    const mon = status?.chatMonitoring;
    const listed = !!surface && !!mon && mon.state !== 'off' && mon.surfaces.includes(surface);

    const gate = useAgentChatSignalsGate(agentId, { enabled: listed && surface === 'agent' });
    const preference = useChatSignalsPreference({ enabled: listed });
    const { mutateAsync: savePreference } = useSetChatSignalsPreference();

    const notice = useMemo(() => noticeFor({
        status,
        surface,
        agentGate: surface === 'agent' ? gate.data ?? null : null,
        optedOut: preference.data?.counted === false,
    }), [status, surface, gate.data, preference.data]);

    const setCounted = useCallback(async (counted: boolean) => {
        await savePreference({ counted });
    }, [savePreference]);

    const payload = useCallback(
        (s: ChatSignalsTurnSurface) => (notice && s === notice.surface ? payloadFor(notice) : null),
        [notice],
    );

    return { notice, setCounted, payloadFor: payload };
}
