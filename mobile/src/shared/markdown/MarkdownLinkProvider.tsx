/**
 * Where a Markdown link to one of Bee Flow's own screens goes.
 *
 * The table that knows which web screen has a native twin belongs to the
 * notifications feature (`translateWebLink`), and shared code may not import a
 * feature — so app/_layout.tsx hands it down here, the way it hands the header
 * its accessories. Without a provider (a test rendering one bubble) an app
 * path has no screen here, so only one the web draws on a phone opens there
 * (links.ts).
 */

import React, { createContext, useContext, type ReactNode } from 'react';

import type { AppLinkTranslator } from './links';

const noTranslation: AppLinkTranslator = () => null;

const MarkdownLinkContext = createContext<AppLinkTranslator>(noTranslation);

export function MarkdownLinkProvider({ translate, children }: { translate: AppLinkTranslator; children: ReactNode }) {
    return <MarkdownLinkContext.Provider value={translate}>{children}</MarkdownLinkContext.Provider>;
}

export function useAppLinkTranslator(): AppLinkTranslator {
    return useContext(MarkdownLinkContext);
}
