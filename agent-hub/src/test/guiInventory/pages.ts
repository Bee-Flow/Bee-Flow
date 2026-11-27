/**
 * Which screen each page key of the app renders, read from the two places that
 * decide it (TypeScript compiler API, sourceAst.ts):
 *
 *   AuthedApp.tsx renderContent()   `if (page === 'admin') return routed(…, <AdminDashboard …/>)`;
 *                                   anything else is <AgentHub/>, with flags such as
 *                                   `showStudio={page === 'studio'}`;
 *   AgentHub/HubMainContent.tsx     the hub's main slot: `currentPage === 'cowork' ? <CoworkPage/>`
 *                                   and the flags above (`showStudio ? …`).
 *
 * A page with no branch of its own is the chat home: AgentHub.
 */

import { jsxAttributeFlags, literalBranches, loadSource, type ComponentRef } from './sourceAst';

const AUTHED_APP = 'src/AuthedApp.tsx';
const HUB_MAIN = 'src/AgentHub/HubMainContent.tsx';

let cached: Map<string, ComponentRef[]> | null = null;

/** Page key -> the components its branch renders (the first is the screen). */
export function pageScreens(): Map<string, ComponentRef[]> {
    if (cached) return cached;
    const app = loadSource(AUTHED_APP);
    const out = new Map(literalBranches(app, ['page']));
    const flags = jsxAttributeFlags(app, 'page');
    for (const [page, refs] of literalBranches(loadSource(HUB_MAIN), ['currentPage'], flags)) {
        if (!out.has(page)) out.set(page, refs);
    }
    cached = out;
    return out;
}

/** The screen of a page key: its first component, or AgentHub (the chat home) when it has no branch. */
export function pageScreen(page: string): ComponentRef | null {
    const refs = pageScreens().get(page);
    if (refs?.length) return refs[0];
    return { name: 'AgentHub', file: loadSource(AUTHED_APP).lazies.get('AgentHub') ?? null };
}
