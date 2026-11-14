/**
 * Webpage framework + runtime-tier vocabulary.
 *
 * A webpage project is one of two FRAMEWORKS ('vanilla': plain HTML/CSS/JS in a
 * sandboxed srcdoc; 'react-mui': a React + Material UI app under src/) and runs
 * in one of two RUNTIME tiers ('light': no server container; 'full': a real
 * per-project Node.js container). Both live in the `webpages.settings` JSONB; an
 * absent or unknown value resolves to 'vanilla' / 'light', so a webpage saved
 * before either setting existed keeps behaving the same.
 *
 * Pure. The webpage routes, the render/snapshot services and the AI builder's
 * framework tools (integrations/webpageFramework.js) all read it, so it lives
 * below them.
 */

export const FRAMEWORKS: [string, ...string[]] = ['vanilla', 'react-mui'];
export const RUNTIMES: [string, ...string[]] = ['light', 'full'];

export const DEFAULT_FRAMEWORK = 'vanilla';
export const DEFAULT_RUNTIME = 'light';

// What a brand-NEW project is created as. React + MUI is the product default.
// A brand-new react-mui project has no src/main.jsx yet, so its preview shows a
// friendly "create src/main.jsx" overlay until the AI scaffolds the app on the
// first request.
export const DEFAULT_NEW_FRAMEWORK = 'react-mui';

type WebpageSettings = { settings?: { framework?: string, runtime?: string } } | null | undefined;

export function resolveFramework(webpage: WebpageSettings): string {
    const f = webpage?.settings?.framework;
    return f !== undefined && FRAMEWORKS.includes(f) ? f : DEFAULT_FRAMEWORK;
}

export function resolveRuntime(webpage: WebpageSettings): string {
    const r = webpage?.settings?.runtime;
    return r !== undefined && RUNTIMES.includes(r) ? r : DEFAULT_RUNTIME;
}
