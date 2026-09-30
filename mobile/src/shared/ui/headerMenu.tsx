/**
 * The drawer toggle a root screen's header shows — the web's mobile header
 * hamburger, which opens the sidebar as an overlay.
 *
 * Supplied, not imported: the drawer is a navigator the kit knows nothing
 * about, so the layout that owns it (features/shell's tabs layout, which sits
 * inside the drawer) provides the "open" action here, and every ScreenHeader
 * under it renders the toggle where a pushed screen renders Back. A header
 * outside the provider — a pushed screen, a test — gets no toggle.
 */

import React, { createContext, useContext, type ReactNode } from 'react';

export interface HeaderMenu {
    /** Opens the navigation drawer. */
    open: () => void;
}

const HeaderMenuContext = createContext<HeaderMenu | null>(null);

export function HeaderMenuProvider({ menu, children }: { menu: HeaderMenu; children: ReactNode }) {
    return <HeaderMenuContext.Provider value={menu}>{children}</HeaderMenuContext.Provider>;
}

/** The nearest drawer toggle, or null outside the drawer. */
export function useHeaderMenu(): HeaderMenu | null {
    return useContext(HeaderMenuContext);
}
