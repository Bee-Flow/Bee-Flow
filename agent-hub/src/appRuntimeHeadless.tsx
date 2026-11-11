import './index.css';
// The self-hosted @font-face rules (Inter, Satoshi, General Sans, Cabinet Grotesk, …): their
// /fonts/… URLs are answered in-process by the render service from agent-hub/public/fonts.
import '@/marketing/self-hosted-fonts.css';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Container } from 'react-dom/client';
import type { AppDefinition } from './components/admin/Studio/AppStudio/inspector/appDefinition';
import { appDesignProps } from './components/admin/Studio/AppStudio/runtime/appDesign';
import AppCustomCss from './components/admin/Studio/AppStudio/runtime/AppCustomCss';
import AppRenderer from './components/admin/Studio/AppStudio/runtime/AppRenderer';
import { loadCustomBlock } from './components/admin/Studio/AppStudio/runtime/components/customBlock/CustomBlockLoader';
import { initialVariableValues } from '@shared/appDefinition/variableScopes.mjs';
import type { DataState } from './components/admin/Studio/AppStudio/runtime/DataContext';
import { CANVAS_GROUND, themeVars } from './components/admin/Studio/AppStudio/runtime/themeVars';
import { mergeRecord, ScreenshotFrame, type ScreenshotView } from './appRuntimeScreenshot';

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
 *   - no data scope app id: every self-fetching component (AppInputRelation's
 *     CandidateLoader, the person picker, documents, dataset lists) needs one,
 *     so nothing ever reaches useAppDataSource's authFetch. The plain mount
 *     also has no QueryClientProvider; screenshot mode (appRuntimeScreenshot.tsx,
 *     the `screenshot` payload the render service sends) adds one with every
 *     query disabled, so input_dataset renders there instead of crashing.
 *   - runAction is a no-op — a screenshot must never fire an action.
 *   - AppFontLoader is deliberately NOT rendered, so the frozen screenshots
 *     keep their look. The self-hosted families are declared by the imported
 *     self-hosted-fonts.css and served in-process by the render service;
 *     Geist, IBM Plex Sans and Poppins (declared by the loader's own
 *     designFonts.css) fall back to their stacks' local entries here.
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
interface HeadlessDefinition extends AppDefinition {
    theme?: { appearance?: string };
}

interface HeadlessScreenProps {
    definition?: HeadlessDefinition;
    previewRole?: string | null;
    screenId?: string;
    dataState?: DataState | null;
    currentUser?: { id: string; name: string; email: string; roleKey: string };
    /** Screenshot mode (appRuntimeScreenshot.tsx); absent = the plain headless render. */
    screenshot?: ScreenshotView | null;
}

/**
 * The starting values: the declared defaults, a screenshot's own values over them, then the
 * derived variables (schema 3) worked out over the screen-level roots, as the render service
 * does when it keys the data (initialVariableValues on both sides).
 */
function headlessVars({ definition, screenId, currentUser, screenshot }: HeadlessScreenProps): Record<string, unknown> {
    const screen = definition?.screens?.find((s) => s.id === screenId);
    return initialVariableValues(definition?.variables, {
        currentUser: currentUser || null,
        vars: mergeRecord({}, screenshot?.vars),
        forms: mergeRecord({}, screenshot?.forms),
        screen: { params: mergeRecord({}, screenshot?.screenParams), id: screenId, name: screen?.name },
        today: new Date().toISOString().slice(0, 10),
    });
}

function HeadlessScreen({ definition, screenId, dataState, currentUser, previewRole, screenshot }: HeadlessScreenProps) {
    // Seed vars exactly like a live run (useActionRunner) does — the render
    // service computes its dataState keys against seeded defaults, so a filter
    // formula reading `vars.x` must see the same value here or the key misses
    // and the component shows a skeleton instead of its rows. A screenshot's
    // `state.vars` lands on top, and the service keys its data the same way.
    const vars = headlessVars({ definition, screenId, currentUser, screenshot });
    if (!screenshot) {
        return <HeadlessGround definition={definition} screenId={screenId} dataState={dataState} currentUser={currentUser} previewRole={previewRole} vars={vars} />;
    }
    const viewer = currentUser ? { name: currentUser.name, email: currentUser.email || undefined, roleKey: currentUser.roleKey, isOwner: currentUser.roleKey === 'owner' } : null;
    const renderer = (
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
            forms={mergeRecord({}, screenshot.forms)}
            screenParams={mergeRecord({}, screenshot.screenParams)}
            initialUi={screenshot.initialUi || null}
        />
    );
    return (
        <ScreenshotFrame view={screenshot} definition={definition} screenId={screenId} viewer={viewer}>
            {screenshot.chrome ? renderer : <HeadlessGround definition={definition}>{renderer}</HeadlessGround>}
        </ScreenshotFrame>
    );
}

type GroundProps = Omit<HeadlessScreenProps, 'screenshot'> & { vars?: Record<string, unknown>; children?: ReactNode };

/** The themed ground with the plain renderer in it, or with `children` in its place. */
function HeadlessGround({ definition, screenId, dataState, currentUser, previewRole, vars, children }: GroundProps) {
    const design = appDesignProps(definition);
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
                <AppCustomCss definition={definition} />
                {children ?? (
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
                )}
            </main>
        </div>
    );
}

/** One turn of the paint loop; jsdom has no rAF unless pretending-to-be-visual. */
function nextFrame() {
    return new Promise<void>((resolve) => {
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
export async function mount(container: Container, {
    definition,
    screenId,
    dataState,
    currentUser,
    previewRole,
    screenshot,
}: Partial<HeadlessScreenProps> = {}) {
    // The custom block's renderer is its own chunk in the app (CustomBlockLoader.tsx); loaded
    // first, the block draws on this one synchronous render like every other component.
    await loadCustomBlock();
    const root = createRoot(container);
    flushSync(() => {
        root.render(
            <HeadlessScreen
                definition={definition}
                screenId={screenId}
                dataState={dataState}
                currentUser={currentUser}
                previewRole={previewRole}
                screenshot={screenshot && typeof screenshot === 'object' ? screenshot : null}
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

