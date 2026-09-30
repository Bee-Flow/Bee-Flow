/**
 * Run `reseed` in the render where a sheet turns visible.
 *
 * React's "adjust state when a prop changes" pattern: comparing with the
 * previous render's value during render, rather than an effect that sets
 * state after the sheet has already painted its stale contents once.
 * `reseed` may only set the calling component's own state.
 */

import { useState } from 'react';

export function useOnOpen(visible: boolean, reseed: () => void): void {
    const [wasVisible, setWasVisible] = useState(visible);
    if (visible !== wasVisible) {
        setWasVisible(visible);
        if (visible) reseed();
    }
}
