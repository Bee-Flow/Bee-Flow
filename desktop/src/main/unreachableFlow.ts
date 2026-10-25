/**
 * What the app does when the workspace window cannot load the server: the
 * state (navigation counter, the one-retry budget, the single flight) and the
 * two flows around the decisions in server/unreachable.ts. No electron import:
 * the window and the page loading come in through the host.
 */

import type { ServerProbeResult } from '../shared/types.ts';
import { failedLoadVerdict, redirectVerdict } from './server/unreachable.ts';

export interface UnreachableHost {
    /** The configured server's address, '' when none. */
    serverUrl(): string;
    /** The address the live main window shows; null when there is no window or it is gone. */
    mainWindowUrl(): string | null;
    /** Probe a server over Chromium's network stack (DesktopApp.probe). */
    probe(url: string): Promise<ServerProbeResult>;
    /** Load an address into the main window. */
    load(url: string): void;
    /** The unreachable page for a server (windows/mainWindow.ts unreachableUrl). */
    unreachablePage(server: string, error: string, code: string, redirectTarget?: string): string;
    /** Adopt a moved server through the checked path (DesktopApp.setServer). */
    setServer(url: string): Promise<unknown>;
    /** Is this address the configured server? */
    isServerNavigation(url: string): boolean;
    warn(tag: string, message: string): void;
}

export class UnreachableFlow {
    private readonly host: UnreachableHost;
    private retriedAfterGoodProbe = false;
    private navigations = 0;
    private navigationStart = '';
    private inFlight: Promise<void> | null = null;

    constructor(host: UnreachableHost) {
        this.host = host;
    }

    /** The main frame starts a navigation (not a same-document one). */
    navigationStarted(url: string): void {
        this.navigations += 1;
        this.navigationStart = url;
    }

    /** The main window finished loading `url`. */
    loaded(url: string): void {
        if (this.host.isServerNavigation(url)) this.retriedAfterGoodProbe = false;
    }

    /** The server failed to load. One at a time: two failures close together would otherwise race to put different pages on screen. */
    show(reason: string): Promise<void> {
        this.inFlight ??= this.explain(reason).finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    private async explain(reason: string): Promise<void> {
        const url = this.host.serverUrl();
        const shown = this.host.mainWindowUrl();
        if (!url || shown === null) return;
        // A failure to load the error page would otherwise put this straight
        // back on screen, forever. One attempt is the whole budget.
        if (shown.startsWith('file://')) return;
        // Probe rather than repeat Chromium's message: the probe distinguishes
        // "certificate expired" from "nothing listening" from "not Bee Flow",
        // and those have three different fixes.
        const before = this.navigations;
        const probe = await this.host.probe(url);
        // The probe can take a while. If the window has moved on meanwhile —
        // the user reloaded, or navigated somewhere that worked — this verdict
        // is about a page nobody is looking at any more.
        if (this.navigations !== before || this.host.mainWindowUrl() === null) return;
        const verdict = failedLoadVerdict(probe, this.retriedAfterGoodProbe, reason);
        if (verdict.kind === 'retry') {
            // The server answers the probe, so this was a blip (a restart, a
            // network change mid-load). One quiet retry beats an error page
            // with a green "the server answered" on it.
            this.retriedAfterGoodProbe = true;
            this.host.load(url);
            return;
        }
        this.retriedAfterGoodProbe = false;
        this.host.load(this.host.unreachablePage(url, verdict.error, verdict.code, verdict.redirectTarget));
    }

    /**
     * The saved server answered its own address with a redirect somewhere the
     * window may not follow — it moved, or someone moved it. Refusing and
     * handing the target to the browser left the window blank, with a new
     * browser tab on every launch and nothing in the log. Instead: a move
     * that is strictly the same server (http becoming https, another port on
     * the same host) is adopted through setServer, which checks it; anything
     * else goes to the unreachable page, which names the new address and lets
     * the person choose it.
     */
    redirectRefused(target: string): boolean {
        const server = this.host.serverUrl();
        if (!server || this.host.mainWindowUrl() === null) return false;
        if (!this.host.isServerNavigation(this.navigationStart)) return false;
        this.host.warn('Server', `${server} now redirects to ${target}`);
        const verdict = redirectVerdict(server, target);
        if (verdict.kind === 'adopt') {
            void this.host.setServer(verdict.url);
            return true;
        }
        this.host.load(this.host.unreachablePage(server, verdict.error, verdict.code, verdict.redirectTarget));
        return true;
    }
}
