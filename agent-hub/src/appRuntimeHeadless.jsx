import './index.css';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { appDesignProps } from './components/admin/Studio/AppStudio/runtime/appDesign';
import AppRenderer from './components/admin/Studio/AppStudio/runtime/AppRenderer';
import { seedVariableDefaults } from './components/admin/Studio/AppStudio/runtime/appVariables';
import { CANVAS_GROUND, themeVars } from './components/admin/Studio/AppStudio/runtime/themeVars';

/**
 * App Studio headless runtime — the entry the SERVER-SIDE screenshot pipeline
 * bundles (vite.runtime.config.js → dist-runtime/app-runtime.{mjs,css}) and
 * serves into a network-less Playwright page (server/services/appStudioRender.js
 * fulfils it in-process, webpageRender.js-style).
 *
 * It renders the SAME components a real viewer sees — AppRenderer + the full
 * component registry, run mode, themed — with the data layer cut off at the
 * contract seam: AppDataScope (the thing that FETCHES) is bypassed entirely and
 * the caller hands in `dataState` pre-resolved, keyed by dataCacheKey exactly
 * as DataContext would hold it. AppRenderer builds the runtime context
 * (actionState/dataState/scope/runAction/mode) from its props, so passing the
 * props directly IS supplying the context — the same wiring Canvas.jsx's
 * preview branch uses, minus the AppDataScope wrapper around it.
 *
 * ZERO NETWORK by construction, not by luck:
 *   - no QueryClientProvider is mounted. Every self-fetching component
 *     (AppInputRelation's CandidateLoader) probes for one and stays inert
 *     without it, so nothing ever reaches useAppDataSource's authFetch.
 *   - runAction is a no-op — a screenshot must never fire an action.
 *   - AppFontLoader is deliberately NOT rendered (it injects Google Fonts
 *     <link>s); design fonts fall back to their stacks' local entries, which
 *     is fine for judging layout.
 */

const noop = () => {};

/**
 * The stand-in for AppShell's root: same theme stamping (themeVars + design +
 * appearance attribute + --bg-primary ground) so app-tokens.css's
 * [data-app-appearance] overrides and the surface/motion/font classes apply,
 * but none of the nav chrome — the screenshot judges the SCREEN the builder
 * just assembled. minHeight pins the ground to the viewport so an
 * almost-empty screen still screenshots as a themed page, not a white strip;
 * the flex column is what lets height:'fill' sections actually fill it.
 */
function HeadlessScreen({ definition, screenId, dataState, currentUser, previewRole }) {
    const design = appDesignProps(definition);
    // Seed vars exactly like a live run (useActionRunner) does — the render
    // service computes its dataState keys against seeded defaults, so a filter
    // formula reading `vars.x` must see the same value here or the key misses
    // and the component shows a skeleton instead of its rows.
    const vars = seedVariableDefaults(definition?.variables);
    return (
        <div
            className={`app-shell flex flex-col w-full${design.className ? ` ${design.className}` : ''}`}
            data-app-appearance={definition?.theme?.appearance || 'auto'}
            style={{
                minHeight: '100vh',
                ...themeVars(definition?.theme),
                ...design.style,
                background: CANVAS_GROUND,
                color: 'var(--text-primary)',
            }}
        >
            <main className="flex flex-col flex-1 min-h-0">
                <AppRenderer
                    definition={definition}
                    screenId={screenId}
                    mode="run"
                    actionState={{}}
                    dataState={dataState || {}}
                    runAction={noop}
                    currentUser={currentUser || null}
                    previewRole={previewRole || null}
                    vars={vars}
                />
            </main>
        </div>
    );
}

/** One turn of the paint loop; jsdom has no rAF unless pretending-to-be-visual. */
function nextFrame() {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
        else setTimeout(resolve, 0);
    });
}

/**
 * mount(container, { definition, screenId, dataState, currentUser, previewRole })
 * → resolves once the screen is committed AND painted (flushSync commits the
 * tree synchronously; the two frames after it let passive effects run — charts
 * measure their box in one — and the browser produce a frame, so a screenshot
 * taken on resolve sees the settled layout).
 *
 * Returns { unmount } for hosts that re-render into the same page.
 */
export async function mount(container, {
    definition,
    screenId,
    dataState,
    currentUser,
    previewRole,
} = {}) {
    const root = createRoot(container);
    flushSync(() => {
        root.render(
            <HeadlessScreen
                definition={definition}
                screenId={screenId}
                dataState={dataState}
                currentUser={currentUser}
                previewRole={previewRole}
            />,
        );
    });
    await nextFrame();
    await nextFrame();
    return { unmount: () => root.unmount() };
}

// Helpers the render service needs to BUILD dataState with the exact keys the
// runtime reads: collectDataBindings lists every data binding on a screen,
// dataCacheKey is the keying function DataContext entries live under. Exported
// from the bundle so server and client can never drift on the key format.
export { collectDataBindings } from './components/admin/Studio/AppStudio/runtime/AppDataScope';
export { dataCacheKey } from './components/admin/Studio/AppStudio/runtime/resolveBinding';

export default mount;
