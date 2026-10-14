import { useCallback, useMemo, useState } from 'react';
import scopedStorage from '../../../../../../utils/scopedStorage';
import { CHAT } from './ShellPanes';
import type { SidePane } from './ShellPanes';

/** The live build, published by the chat pane and read by the canvas. */
export interface BuildCue {
    todos?: unknown[];
    running?: boolean;
    [key: string]: unknown;
}

interface ChromeInputs {
    chatPane: SidePane;
    commitTurn: unknown;
    markSaved: unknown;
    flush: unknown;
    appId: string | null;
    undo: () => void;
}

/**
 * The shell's editing handles for the AI chat pane (EditorChromeContext), and
 * the build cue the pane publishes for the canvas.
 *
 * appId is exposed so the inspector's BI "Configure data" builder can reach
 * the data API without threading a prop through every panel. undoTurn = the
 * shell's single history.undo — the chat pane's "Undo turn" affordance reuses
 * it (an AI turn is committed as ONE history entry, so one undo reverts the
 * whole turn). The live build is state here because the pane and the canvas
 * are siblings under the shell (see BuildCueContext.js).
 */
export function useChromeHandles({ chatPane, commitTurn, markSaved, flush, appId, undo }: ChromeInputs) {
    const { setOpen: setChatOpen } = chatPane;
    // Reach the AI composer from anywhere (⌘K's "Ask the AI builder"): open
    // the chat pane FIRST — focus() inside a display:none subtree is a no-op,
    // and the collapsed state is persisted, so without this the command was
    // permanently dead for anyone who had ever collapsed the pane. The focus
    // itself waits a frame so it runs after the un-hide has committed.
    const focusAiChat = useCallback(() => {
        setChatOpen((open) => {
            if (!open) scopedStorage.setItem(CHAT.openKey, '1');
            return true;
        });
        requestAnimationFrame(() => {
            if (typeof document === 'undefined') return;
            const el = document.querySelector<HTMLElement>('[data-app-ai-composer]');
            if (el && typeof el.focus === 'function') el.focus();
        });
    }, [setChatOpen]);

    const [buildCue, setBuildCue] = useState<BuildCue | null>(null);
    const chrome = useMemo(
        () => ({ commitTurn, markSaved, flush, appId, undoTurn: undo, focusAiChat, publishBuildCue: setBuildCue }),
        [commitTurn, markSaved, flush, appId, undo, focusAiChat],
    );
    return { chrome, buildCue };
}
