import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import toast from '@/components/shared/Toast';

/** What the autosave flush resolves to; it never rejects. */
export type FlushResult = { ok?: boolean; error?: string } | null | undefined | void;

interface FlushGuardInputs {
    t: TranslateFn;
    isManaged: boolean;
    onFlush?: () => Promise<FlushResult> | FlushResult;
    onClose?: () => void;
}

export interface FlushGuards {
    closing: boolean;
    handleClose: () => Promise<void>;
    publishOpen: boolean;
    setPublishOpen: (open: boolean) => void;
    preparingPublish: boolean;
    openPublish: () => Promise<void>;
    /** The latest openPublish, for memoised callers (the command palette). */
    openPublishRef: RefObject<(() => void) | null>;
}

/**
 * Closing and publishing both flush pending autosaves first, and both READ
 * the result: the flush RESOLVES on failure (autosave turns every error into
 * a status, it never rejects), so a `finally` would throw away work that
 * never reached the server.
 */
export function useFlushGuards({ t, isManaged, onFlush, onClose }: FlushGuardInputs): FlushGuards {
    // ---- close -------------------------------------------------------------
    const [closing, setClosing] = useState(false);
    const handleClose = async () => {
        if (closing) return;
        setClosing(true);
        try {
            const res = await onFlush?.();
            if (res && res.ok === false) {
                toast.error(`${res.error || t('app_studio.header.save_failed', 'Saving failed')}. ${t('app_studio.header.close_kept', 'Your changes are still here — the editor stays open.')}`);
                return;
            }
            onClose?.();
        } finally {
            setClosing(false);
        }
    };

    // ---- publish -----------------------------------------------------------
    // The audience picker (Private / Entire org / Specific groups) lives in
    // PublishModal; it builds the PATCH payload and reports the updated app
    // back through onAppUpdated. The header only owns open/close.
    const [publishOpen, setPublishOpen] = useState(false);
    /*
     * Publishing freezes the definition AS THE SERVER HAS IT. Autosave is
     * debounced, so clicking Publish within that window froze the PREVIOUS
     * draft while the modal promised "a copy of the app as it is now" — the
     * edit you made just before publishing was the one that did not go live,
     * and nothing said so. Closing the editor already flushed for exactly this
     * reason; publishing has more at stake and did not.
     *
     * Same contract as handleClose. A draft that could not be saved must not
     * be published — it would freeze a version the author cannot see.
     */
    const [preparingPublish, setPreparingPublish] = useState(false);
    // The command palette's action list is memoised on what changes the LIST,
    // so it must not capture this closure directly — it would go stale on
    // `onFlush`, which is exactly the part that has to be current.
    const openPublishRef = useRef<(() => void) | null>(null);
    const openPublish = async () => {
        if (preparingPublish) return;
        // A managed app has no draft of its own to freeze: only the audience moves.
        if (isManaged) { setPublishOpen(true); return; }
        setPreparingPublish(true);
        try {
            const res = await onFlush?.();
            if (res && res.ok === false) {
                toast.error(`${res.error || t('app_studio.header.save_failed', 'Saving failed')}. ${t('app_studio.header.publish_not_opened', 'Publishing would freeze the last version that saved, so it has not opened.')}`);
                return;
            }
            setPublishOpen(true);
        } finally {
            setPreparingPublish(false);
        }
    };
    openPublishRef.current = openPublish;

    return { closing, handleClose, publishOpen, setPublishOpen, preparingPublish, openPublish, openPublishRef };
}
