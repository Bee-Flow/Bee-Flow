import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';
import { cookieReserve } from './cookieBannerLayout';
import type { CookieLayout } from './cookieBannerLayout';

/**
 * Keeps the end of the page (the footer) reachable while the banner is open:
 * pads the page bottom by the banner's height, and puts back whatever was
 * there when the banner closes or unmounts.
 */
export function useCookieReserve(open: boolean, layout: CookieLayout, bannerRef: RefObject<HTMLElement | null>): void {
    useLayoutEffect(() => {
        if (!open) return undefined;
        const body = document.body;
        const before = body.style.paddingBottom;
        const apply = () => {
            const height = bannerRef.current?.getBoundingClientRect().height ?? 0;
            body.style.paddingBottom = `${cookieReserve(layout, height)}px`;
        };
        apply();
        window.addEventListener('resize', apply);
        return () => {
            window.removeEventListener('resize', apply);
            body.style.paddingBottom = before;
        };
    }, [open, layout, bannerRef]);
}
