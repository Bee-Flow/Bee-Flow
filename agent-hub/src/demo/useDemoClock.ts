import { useLayoutEffect } from 'react';
import { installDemoClock, uninstallDemoClock } from './demoClock';

/**
 * Keeps the page on the demo's clock for as long as the calling host is
 * mounted (demoClock.ts says why the page needs it at all).
 *
 * An effect and its cleanup, nothing during render: a render that throws, or
 * one React throws away, has then installed nothing that could be left behind,
 * and StrictMode's mount / unmount / mount comes out as one install. A layout
 * effect, so it is in place before anything is painted; the host renders its
 * feature only after its fixtures have loaded, which is later still.
 */
export default function useDemoClock(active: boolean): void {
    useLayoutEffect(() => {
        if (!active) return undefined;
        installDemoClock();
        return uninstallDemoClock;
    }, [active]);
}
