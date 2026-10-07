import { useCallback, useState } from 'react';
import { EMBED_NOTICE_OFF, embedMarker, parseComplianceNotice, type EmbedComplianceNotice } from '../../api/queries/chatSignals';
import { embedSourcesAllowed } from '../chat/MessageItem/messageItemHelpers';

/**
 * What the embed payload decides for a website visitor, and what the
 * visitor chose on this page view.
 *
 *   sourcesAllowed  whether this agent's owner allows the sources behind an
 *                   answer to be shown on the public widget. Starts CLOSED
 *                   and only ever opens on an explicit yes from the payload:
 *                   a failed fetch, an old server that does not send the
 *                   field, or a half-loaded page all leave it shut.
 *   notice          the chat-signals notice (off until the payload says
 *                   otherwise), and `turnFields()` the marker a turn carries
 *                   because that notice was shown.
 *   dontCount       "Don't count my messages": React state only, for this
 *                   page view. Nothing is stored on the visitor's device.
 */
export default function useEmbedVisitorState() {
    const [sourcesAllowed, setSourcesAllowed] = useState(false);
    const [notice, setNotice] = useState<EmbedComplianceNotice>(EMBED_NOTICE_OFF);
    const [dontCount, setDontCount] = useState(false);

    const applyEmbedPayload = useCallback((data: unknown) => {
        setSourcesAllowed(embedSourcesAllowed(data));
        setNotice(parseComplianceNotice(data));
    }, []);

    /** The chat-signals fields of a stream request: none at all while nothing is announced. */
    const turnFields = useCallback((): { chatSignalsNotice?: string; chatSignalsOptOut?: true } => {
        const marker = embedMarker(notice);
        return {
            ...(marker ? { chatSignalsNotice: marker } : {}),
            ...(dontCount ? { chatSignalsOptOut: true as const } : {}),
        };
    }, [notice, dontCount]);

    return { sourcesAllowed, notice, dontCount, setDontCount, applyEmbedPayload, turnFields };
}
