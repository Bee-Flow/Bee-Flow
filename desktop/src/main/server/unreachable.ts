/**
 * What the workspace window does when the server will not load.
 *
 * Two decisions, both about the configured server and nothing else:
 *
 * - After a failed load, the probe's verdict decides between one quiet retry
 *   (the server answers, so this was a blip: a restart, a network change
 *   mid-load) and the unreachable page that explains it. The probe
 *   distinguishes "certificate expired" from "nothing listening" from "not
 *   Bee Flow", and those have three different fixes.
 * - When the server answers its own address with a redirect the window may
 *   not follow, a move that is strictly the same server (http becoming https,
 *   another port on the same host) is adopted; anything else goes to the
 *   unreachable page, which names the new address and lets the person
 *   choose it.
 */

import type { ServerProbeResult } from '../../shared/types.ts';
import { adoptsRedirect } from './probe.ts';
import { normaliseServerUrl } from './url.ts';

/** What the unreachable page is told: the arguments of `unreachableUrl` after the server. */
export interface UnreachableExplanation {
    kind: 'explain';
    error: string;
    code: string;
    redirectTarget?: string;
}

export type FailedLoadVerdict = { kind: 'retry' } | UnreachableExplanation;

/**
 * After a failed load of the server, with the probe's answer in hand.
 *
 * `retriedAlready` is the one-retry budget: a server that answers the probe
 * but keeps failing to load gets the page after the first quiet retry.
 */
export function failedLoadVerdict(probe: ServerProbeResult, retriedAlready: boolean, reason: string): FailedLoadVerdict {
    if (probe.ok && !retriedAlready) return { kind: 'retry' };
    return { kind: 'explain', error: probe.error ?? reason, code: probe.code ?? 'unknown', redirectTarget: probe.redirectTarget };
}

export type RedirectVerdict = { kind: 'adopt'; url: string } | UnreachableExplanation;

/** The saved server redirected its own address to `target`, which the window refused. */
export function redirectVerdict(server: string, target: string): RedirectVerdict {
    const moved = normaliseServerUrl(target);
    if (moved.ok && adoptsRedirect(server, moved.url)) return { kind: 'adopt', url: moved.url };
    return { kind: 'explain', error: `Your server now sends you to ${target}.`, code: 'redirected', redirectTarget: target };
}
