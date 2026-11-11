import MobileNav from './MobileNav';
import UserMenu from './UserMenu';
import type { NavModel, NavScreen } from './navModel';
import type { ShellItem } from './shellOptions';
import type { UserMenuViewer } from './UserMenu';
import type { NavigateFn } from '../actionRunner/runnerContext';

/**
 * The parts the shell options add (shellOptions.ts, schema 3): the corner menu that stands in
 * for a hidden bar, and the footer line (the app's own links are NavLinks.tsx). AppShell
 * places them; an app that sets none of the options never renders one.
 */

interface CornerProps {
    model: NavModel | null;
    activeScreen: NavScreen | null;
    onNavigate: NavigateFn | null;
    viewer: UserMenuViewer | null;
    onExit: (() => void) | null;
    items?: ShellItem[];
}

/**
 * The corner that stands in for a hidden top bar or no navigation at all: the screen menu
 * (with more than one screen or a link; `model` null leaves it out) and the viewer's own menu, so the
 * viewer is never shut inside the app. Renders nothing when it has nothing to offer.
 */
export function ShellCorner({ model, activeScreen, onNavigate, viewer, onExit, items = [] }: CornerProps) {
    const hasMenu = !!model && (model.flat.length > 1 || items.length > 0);
    if (!hasMenu && !viewer) return null;
    return (
        <div className="absolute top-2 right-3 z-20 flex items-center gap-2" data-app-shell-corner="true">
            {hasMenu && model ? <MobileNav variant="inline" always model={model} activeScreen={activeScreen} onNavigate={onNavigate} items={items} /> : null}
            <UserMenu viewer={viewer} onExit={onExit} direction="down" />
        </div>
    );
}

/** The footer line under every screen. */
export function ShellFooter({ text }: { text: string | null }) {
    if (!text) return null;
    return (
        <footer
            className="shrink-0 border-t px-4 py-2 text-xs text-[var(--text-secondary)] [border-color:var(--border-default)]! [background:var(--bg-card)]"
            data-app-shell-footer="true"
        >
            {text}
        </footer>
    );
}
