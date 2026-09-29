import { useState, useCallback } from 'react';

// Behavior toggles (allowCopy / external tools / embedEnabled with its
// public-access confirm gate) for BuilderSplit. Moved verbatim; the hook is
// called from the same position in the parent, so the internal hooks keep
// their order and the state stays on BuilderSplit's fiber.
export default function useBehaviorToggles({ allowCopy, setAllowCopy, disableExternalTools, setDisableExternalTools, embedEnabled, setEmbedEnabled, stateRef, dirtyRef, queueSave, patchConfig }) {
    // Behavior toggles
    const toggleAllowCopy = () => {
        const next = !allowCopy;
        setAllowCopy(next);
        patchConfig({ allowCopy: next });
    };
    const toggleDisableExternalTools = () => {
        const next = !disableExternalTools;
        setDisableExternalTools(next);
        patchConfig({ disableExternalTools: next });
    };
    // Persist `embedEnabled`. Going embed-OFF is silent (defensive). Going
    // embed-ON exposes the agent on the public /chat/<id> route, so we gate
    // it behind a confirmation modal — the actual flip happens via
    // `confirmEnableEmbed` after the user accepts.
    const [pendingEmbedEnable, setPendingEmbedEnable] = useState(false);
    const persistEmbedEnabled = useCallback((next) => {
        setEmbedEnabled(next);
        stateRef.current.embedEnabled = next;
        dirtyRef.current = true;
        queueSave(true);
    }, [queueSave]);
    const toggleEmbedEnabled = () => {
        const next = !embedEnabled;
        if (next) {
            setPendingEmbedEnable(true);
        } else {
            persistEmbedEnabled(false);
        }
    };
    const confirmEnableEmbed = () => {
        persistEmbedEnabled(true);
        setPendingEmbedEnable(false);
    };
    const cancelEnableEmbed = () => setPendingEmbedEnable(false);

    return { toggleAllowCopy, toggleDisableExternalTools, pendingEmbedEnable, toggleEmbedEnabled, confirmEnableEmbed, cancelEnableEmbed };
}
