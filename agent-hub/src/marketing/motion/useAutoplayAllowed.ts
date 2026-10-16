import { useEffect, useState } from 'react';

/**
 * Whether decorative video may play on this device right now.
 *
 * No when the visitor asked for reduced motion, when the browser reports a
 * data saver (`connection.saveData`), and (for full-bleed backgrounds) on a
 * phone-width screen, where a looping hero video costs battery and mobile data
 * for very little. In those cases the caller shows the static poster instead.
 * The first render is always "no": the server render and the first client
 * paint are the poster, which is also the LCP image, and the video decision is
 * made after hydration.
 */

interface NetworkInformationLike {
    saveData?: boolean;
}

export interface AutoplayOptions {
    /** Allow phone-width screens (small teaser loops); default false. */
    mobile?: boolean;
}

const REDUCED = '(prefers-reduced-motion: reduce)';
const PHONE = '(max-width: 767px)';

function matches(query: string): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

function dataSaverOn(): boolean {
    const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
    return connection?.saveData === true;
}

export function autoplayAllowed({ mobile = false }: AutoplayOptions = {}): boolean {
    if (typeof window === 'undefined') return false;
    if (matches(REDUCED) || dataSaverOn()) return false;
    return mobile || !matches(PHONE);
}

export default function useAutoplayAllowed(options: AutoplayOptions = {}): boolean {
    const mobile = options.mobile === true;
    const [allowed, setAllowed] = useState(false);
    useEffect(() => {
        const update = () => setAllowed(autoplayAllowed({ mobile }));
        update();
        if (typeof window.matchMedia !== 'function') return undefined;
        const lists = [window.matchMedia(REDUCED), window.matchMedia(PHONE)];
        lists.forEach((l) => l.addEventListener?.('change', update));
        return () => lists.forEach((l) => l.removeEventListener?.('change', update));
    }, [mobile]);
    return allowed;
}
