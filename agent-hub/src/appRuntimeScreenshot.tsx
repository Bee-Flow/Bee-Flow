import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import AppShell from './components/admin/Studio/AppStudio/runtime/AppShell';
import { AssetTransportProvider } from './components/admin/Studio/AppStudio/runtime/assets/assetTransport';
import type { InitialUi } from './components/admin/Studio/AppStudio/runtime/RuntimeContext';
import type { AppDefinition } from './components/admin/Studio/AppStudio/inspector/appDefinition';
import type { UserMenuViewer } from './components/admin/Studio/AppStudio/runtime/shell/UserMenu';

/**
 * Screenshot mode of the headless runtime (appRuntimeHeadless.tsx): what the server-side
 * render (server/services/appStudioRender.js, the builder's app_screenshot) adds around the
 * screen when it sends a `screenshot` object in the mount payload. Without that object the
 * headless entry renders exactly as before; the compat DOM gate mounts it that way.
 *
 *   - a QueryClient, so a component that reads one (input_dataset's existing-datasets list)
 *     renders instead of crashing. Every component that fetches also needs the data scope's
 *     app id, which this page never has, so nothing is fetched; the client also starts with
 *     every query disabled and no retries. The page has no network either way: the render
 *     service answers every request in-process.
 *   - the asset transport: `asset:<id>` resolves to a URL under the page origin that the
 *     render service answers from the app's own asset store (SCREENSHOT_ASSET_TOKEN).
 *   - `chrome`: the real AppShell (navigation, brand and logo, user menu) around the screen.
 *     Navigation does nothing: a screenshot never fires an action.
 */

/** The public-page token the asset URLs carry here; the render service answers it in-process. */
export const SCREENSHOT_ASSET_TOKEN = 'screenshot';

export interface ScreenshotView {
    chrome?: boolean;
    initialUi?: InitialUi | null;
    vars?: Record<string, unknown> | null;
    forms?: Record<string, unknown> | null;
    screenParams?: Record<string, unknown> | null;
}

interface FrameProps {
    view: ScreenshotView;
    definition?: AppDefinition;
    screenId?: string;
    viewer: UserMenuViewer | null;
    children: ReactNode;
}

const noop = () => {};

function stillQueryClient() {
    return new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } } });
}

/** The providers of screenshot mode, and the shell when `chrome` is asked for. */
export function ScreenshotFrame({ view, definition, screenId, viewer, children }: FrameProps) {
    const [client] = useState(stillQueryClient);
    const body = view.chrome ? (
        // A grid row stretches to the viewport and still grows with a tall screen, so the
        // shell's full-height layout has a definite box without clipping the capture.
        <div className="grid min-h-screen">
            <AppShell definition={definition as never} screenId={screenId} onNavigate={noop} viewer={viewer}>
                {children}
            </AppShell>
        </div>
    ) : children;
    return (
        <QueryClientProvider client={client}>
            <AssetTransportProvider publicToken={SCREENSHOT_ASSET_TOKEN}>{body}</AssetTransportProvider>
        </QueryClientProvider>
    );
}

/** Seeded defaults with the view's overrides on top (only plain objects count). */
export function mergeRecord(base: Record<string, unknown>, over: unknown): Record<string, unknown> {
    return over && typeof over === 'object' && !Array.isArray(over) ? { ...base, ...over as Record<string, unknown> } : base;
}
