import React from 'react';
import { ActivityIndicator } from '../../chat/MessageItem/ActivityIndicator';

/**
 * What the builder's chat column shows before the first token: the same
 * "Thinking…" line agent chat and direct chat show, so the three surfaces
 * wait the same way. Nothing has streamed yet, so the indicator gets an empty
 * message and falls through to its generic branch.
 */
const EMPTY_MSG = {};

export default function BuilderWaitingCard(): React.ReactElement {
    return (
        <div className="self-start" role="status" aria-live="polite" data-testid="builder-waiting-card">
            <ActivityIndicator msg={EMPTY_MSG} />
        </div>
    );
}
