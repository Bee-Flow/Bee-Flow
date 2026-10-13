/**
 * Who may call which IPC channel, as one checked table.
 *
 * Every invoke channel needs one of two levels of trust (see handlers.ts for
 * the reasoning behind each):
 *
 *   - 'trusted': our own pages and the workspace (the Bee Flow server's page);
 *   - 'shell':   only a page THIS APP shipped.
 *
 * A sender of 'other' trust (an identity provider mid-sign-in, a popup, the
 * single sign-on origin) gets nothing at all.
 *
 * `gatedHandle` applies the table before a handler body runs, so the gate does
 * not depend on each body remembering its own `requireShell`/`requireTrusted`
 * call. The bodies keep those calls; the two must agree, and a channel missing
 * from the table is a type error here and a refusal at registration time.
 *
 * Deliberately free of `electron`: the tests drive it with a stub `ipcMain`,
 * and the preload never imports it.
 */

import { INVOKE, type InvokeChannel } from '../../shared/ipc.ts';
import type { SenderTrust } from '../security/policy.ts';

export type ChannelTrust = 'shell' | 'trusted';

export const CHANNEL_TRUST: Record<keyof typeof INVOKE, ChannelTrust> = {
    // ── App ──
    diagnostics: 'trusted',
    openExternal: 'trusted',
    openSettings: 'trusted',
    showItemInFolder: 'trusted',
    relaunch: 'shell',

    // ── Settings ──
    settingsGet: 'trusted',
    settingsPatch: 'shell',

    // ── Server ──
    serverGet: 'trusted',
    serverProbe: 'shell',
    serverSet: 'shell',
    serverForget: 'shell',
    serverChoose: 'shell',

    // ── Updates ──
    updateCheck: 'trusted',
    updateInstall: 'shell',

    // ── Nextcloud ──
    ncStatus: 'trusted',
    ncRefresh: 'trusted',
    ncResolve: 'trusted',
    ncPickFiles: 'trusted',
    ncShare: 'trusted',
    ncReveal: 'trusted',
    ncOpenInNextcloud: 'trusted',
    ncSave: 'trusted',
    ncLoginStart: 'trusted',
    ncLoginCancel: 'trusted',
    ncWatchList: 'trusted',
    ncWatchAdd: 'trusted',
    ncWatchRemove: 'shell',
    ncWatchUpdate: 'shell',

    // ── Notifications / badge ──
    notify: 'trusted',
    setBadge: 'trusted',
};

const TRUST_BY_CHANNEL: ReadonlyMap<string, ChannelTrust> = new Map(
    (Object.keys(INVOKE) as Array<keyof typeof INVOKE>).map((key) => [INVOKE[key], CHANNEL_TRUST[key]]),
);

/** The trust a channel requires, or undefined for a channel that is not in the contract. */
export function requiredTrust(channel: string): ChannelTrust | undefined {
    return TRUST_BY_CHANNEL.get(channel);
}

/** Whether a sender of `trust` may call a channel that requires `required`. */
export function isAllowed(required: ChannelTrust, trust: SenderTrust): boolean {
    return required === 'shell' ? trust === 'shell' : trust !== 'other';
}

export class RefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RefusedError';
    }
}

/** The message a refused caller sees, worded like the per-handler refusals. */
export function refusalMessage(required: ChannelTrust, what: string): string {
    return required === 'shell'
        ? `${what} can only be done from Bee Flow's own settings window.`
        : `${what} is only available to your Bee Flow workspace.`;
}

/** The shape of an invoke event this module needs; Electron's IpcMainInvokeEvent fits it. */
export interface GateEvent {
    senderFrame?: { url?: string } | null;
}

export interface GateDeps<E extends GateEvent> {
    ipcMain: { handle(channel: string, listener: (event: E, ...args: unknown[]) => unknown): void };
    trustOf(event: E): SenderTrust;
    log: { warn(scope: string, message: string): void };
}

/**
 * Build the `handle(channel, handler)` that registers an invoke handler behind
 * the channel's gate. An untrusted sender is refused (logged, then rejected)
 * before the handler runs; a handler's own error is logged and rethrown.
 */
export function gatedHandle<E extends GateEvent>(deps: GateDeps<E>) {
    return (channel: InvokeChannel, handler: (event: E, ...args: never[]) => unknown): void => {
        const required = requiredTrust(channel);
        // Fail closed: a channel nobody classified is a programming error, and
        // registering it ungated would be exactly the hole this table closes.
        if (!required) throw new Error(`IPC channel ${channel} has no entry in CHANNEL_TRUST.`);

        deps.ipcMain.handle(channel, async (event, ...args) => {
            if (!isAllowed(required, deps.trustOf(event))) {
                deps.log.warn('IPC', `refused ${channel} from ${event.senderFrame?.url ?? 'an unknown frame'}`);
                throw new RefusedError(refusalMessage(required, 'This'));
            }
            try {
                return await handler(event, ...(args as never[]));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                deps.log.warn('IPC', `${channel} failed: ${message}`);
                throw error;
            }
        });
    };
}
