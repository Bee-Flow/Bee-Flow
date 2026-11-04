/**
 * The run log of a browser run (server: appStudio/runLog/clickRuns.mts). A server-touching
 * sequence makes one run key; every server step it sends carries it (serverSteps.stepBody, also
 * the steps of a called action, which post to the ROOT action), and exactly one end report goes
 * out when the sequence settles. Silent: the log never shows the viewer an error.
 */
import { actionsUrl, postKeepalive } from '@/api/actionHttp';
import { logger } from '@/utils/logger';

/** What the sequence shares with its copies (loop iterations, called actions): one object. */
export interface RunTrack {
    runKey: string;
    /** Server steps sent; no step, no run row, no end report. */
    serverSteps: number;
    /** An onError handler dealt with a failure. */
    handled: boolean;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** rk_ + 24 random characters (the server's CLIENT_RUN_KEY_RE). */
function newRunKey(): string {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    let out = 'rk_';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    return out;
}

export function newRunTrack(): RunTrack {
    return { runKey: newRunKey(), serverSteps: 0, handled: false };
}

export type RunEnd = { status: 'success' | 'error' | 'cancelled'; error?: string | null };

/** The end report; a no-op when no server step was sent. Never throws, never toasts. */
export async function reportRunEnd(appId: string | null, actionId: string, draft: boolean, run: RunTrack | undefined, end: RunEnd): Promise<void> {
    if (!run || run.serverSteps === 0) return;
    try {
        await postKeepalive(`${actionsUrl(appId)}/${encodeURIComponent(actionId)}/runs/end${draft ? '?draft=1' : ''}`, {
            runKey: run.runKey,
            status: end.status,
            ...(end.error ? { error: String(end.error).slice(0, 300) } : {}),
            ...(run.handled ? { handled: true } : {}),
        });
    } catch (err) {
        logger.debug('run end report not sent', err);
    }
}
