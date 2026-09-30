/**
 * The page header's actions that leave the app: the PUBLIC page in the
 * system's browser (the page itself is previewed inside the app, see
 * components/PreviewTab.tsx) and the PDF export, handed to the share sheet.
 * Neither changes the page, so neither refreshes anything.
 */

import * as WebBrowser from 'expo-web-browser';

import { usePageMutation, type Handlers } from './pageMutation';
import { exportWebpagePdf } from '../api/endpoints';
import { absoluteUrl } from '../model/links';
import type { Webpage } from '../model/types';

const NOTHING = () => [];

/**
 * The page's public address, /w/<slug>, while the page IS public. The slug
 * outlives switching public off (only `publicShareId` is cleared), and the
 * address then answers 404, so it is offered only while both are set.
 */
export function publicPagePath(webpage: Webpage): string | null {
    return webpage.slug && webpage.publicShareId ? `/w/${encodeURIComponent(webpage.slug)}` : null;
}

export function useOpenPublicPage(webpage: Webpage, handlers: Handlers<void, void> = {}) {
    return usePageMutation(
        webpage.id,
        async () => {
            const path = publicPagePath(webpage);
            if (path) await WebBrowser.openBrowserAsync(absoluteUrl(path), { createTask: false });
        },
        { handlers, refresh: NOTHING },
    );
}

export function useExportPdf(webpage: Webpage, handlers: Handlers<void, void> = {}) {
    return usePageMutation(webpage.id, () => exportWebpagePdf(webpage.id, webpage.name), {
        handlers,
        refresh: NOTHING,
    });
}
