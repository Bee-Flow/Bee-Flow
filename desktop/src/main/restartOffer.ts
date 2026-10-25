/**
 * A new plain-http server on a private address needs the secure-context
 * switch, which only takes effect at startup. The workspace works without it;
 * encrypted sign-in (OPAQUE, PIN unlock) does not. So: ask, once at a time.
 * No electron import; the dialog and the relaunch come in through the host.
 */

import { secureContextOrigin } from './server/secureOrigin.ts';

export interface RestartOfferHost {
    /** The origin this run started with the switch for, if any. */
    secureOrigin: string | null;
    /** Show the question; resolves to the index of the button pressed. */
    ask(options: {
        type: 'info';
        buttons: string[];
        defaultId: number;
        cancelId: number;
        title: string;
        message: string;
        detail: string;
    }): Promise<number>;
    relaunch(): void;
}

export class RestartOffer {
    private readonly host: RestartOfferHost;
    private offered = false;

    constructor(host: RestartOfferHost) {
        this.host = host;
    }

    offer(serverUrl: string): void {
        const wanted = secureContextOrigin(serverUrl);
        if (!wanted || wanted === this.host.secureOrigin || this.offered) return;
        this.offered = true;
        void this.host
            .ask({
                type: 'info',
                buttons: ['Restart now', 'Later'],
                defaultId: 0,
                cancelId: 1,
                title: 'Restart to finish connecting',
                message: `Restart Bee Flow to finish connecting to ${wanted}.`,
                detail: 'This server is reached over plain http. Bee Flow can still use encrypted sign-in with it on your own network, but only after a restart.',
            })
            .then((response) => {
                this.offered = false;
                if (response === 0) this.host.relaunch();
            });
    }
}
