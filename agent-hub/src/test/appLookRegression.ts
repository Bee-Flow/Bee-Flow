// The web half of the App Studio compatibility gate (server/appStudio/compat/README.md).
//
// Every screen of every corpus app is mounted through the headless runtime entry
// (src/appRuntimeHeadless.tsx: the real AppRenderer and component registry, run mode,
// no network) and written down as text: the element tree with its classes, attributes,
// inline style declarations and text. The lookRegression.*.test.tsx files compare that
// text against a committed snapshot per corpus app.
//
// The output is deterministic by construction:
//   - the clock is fixed and a missing locale means en-US (fixedClock); dates and times
//     are masked, since they print in the machine's time zone (maskDates),
//   - every data binding gets an EMPTY, successful answer (emptyDataState), keyed the
//     way the fetch layer keys it, so no component waits on a loader,
//   - any other request answers 401 without touching the network (noSession),
//   - ids React generates (useId) are numbered in order of appearance, and so are the
//     ids dnd-kit counts per process (DndDescribedBy-<n>, DndLiveRegion-<n>), per screen,
//   - class tokens starting with `bfa-` or `u-` are dropped: a later package adds those
//     as part classes, and adding a class is not a change in how an app looks,
//   - the inside of an <svg> is left out (an icon is named by its class; a lucide
//     upgrade that redraws a path is not an app change).
//
// A corpus app whose `about.lookChrome` is true is drawn inside the real AppShell (the
// screenshot mode `chrome`, appRuntimeScreenshot.tsx), for vocabulary that lives in the shell
// (nav.*). Every other app is drawn without it, as it always was.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@/appRuntimeHeadless';
import { collectDataBindings } from '@/components/admin/Studio/AppStudio/runtime/AppDataScope';
import { initialVariableValues } from '@shared/appDefinition/variableScopes.mjs';
import { dataCacheKey, resolveBindingFilters, resolveBindingParams, resolveBindingShape } from '@/components/admin/Studio/AppStudio/runtime/resolveBinding';
import type { AppDefinition } from '@/components/admin/Studio/AppStudio/inspector/appDefinition';
import type { DataEntry, DataState } from '@/components/admin/Studio/AppStudio/runtime/DataContext';
import type { Binding } from '@/components/admin/Studio/AppStudio/runtime/resolveBinding.types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const CORPUS_DIR = path.resolve(HERE, '../../../server/appStudio/compat/corpus');
/** Where the committed snapshots live, one text file per corpus app. */
export const SNAPSHOT_DIR = path.resolve(SRC, 'components/admin/Studio/AppStudio/runtime/__lookSnapshots__');

/** The instant every render sees as "now". */
export const FIXED_NOW = '2026-01-15T12:00:00.000Z';

/** The viewer every screen is rendered for: the app owner, as the render service does. */
const VIEWER = { id: 'compat-viewer', name: 'App owner', email: 'viewer@example.com', roleKey: 'owner' };

type CorpusScreen = { id: string; name?: string };
type CorpusDefinition = AppDefinition & { screens?: CorpusScreen[]; variables?: unknown };

/** Every corpus app, sorted by name. */
export function corpusNames(): string[] {
    return fs.readdirSync(CORPUS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .sort();
}

/** The names a shard renders: every `count`-th name starting at `index` (0-based). */
export function shardNames(names: readonly string[], index: number, count: number): string[] {
    return names.filter((_, i) => i % count === index);
}

type CorpusFile = { about?: { lookChrome?: unknown }; definition: CorpusDefinition };

function loadCorpusFile(name: string): CorpusFile {
    return JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, `${name}.json`), 'utf8')) as CorpusFile;
}

/** One corpus app's stored definition. */
export function loadDefinition(name: string): CorpusDefinition {
    return loadCorpusFile(name).definition;
}

/**
 * Fix the clock for the renders of one test file. Only Date is faked: real timers keep
 * running, so effects, lazy imports and the headless frame loop behave as in a browser.
 */
export function fixedClock(): () => void {
    const restoreLocale = pinDefaultLocale();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXED_NOW));
    return () => {
        vi.useRealTimers();
        restoreLocale();
    };
}

/**
 * Keep the renders off the network. A component that loads its own data (the approval
 * list, ...) would otherwise reach whatever listens on API_BASE (localhost:3001 under
 * vitest) on the machine that runs the test, and print that machine's answer: a local
 * Bee Flow stack says 401, a CI runner refuses the connection. The headless
 * render has no session, so every request gets the answer the API gives a request
 * without one.
 */
export function noSession(): () => void {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ error: 'Not authenticated' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
    )));
    return () => vi.unstubAllGlobals();
}

const PINNED_LOCALE = 'en-US';

/** The same function or constructor, with a missing first argument (the locale) filled in. */
function withDefaultLocale<F extends (...args: never[]) => unknown>(fn: F): F {
    const fill = (args: unknown[]) => [args[0] === undefined ? PINNED_LOCALE : args[0], ...args.slice(1)];
    return new Proxy(fn, {
        apply: (target, self, args: unknown[]) => Reflect.apply(target, self, fill(args)),
        construct: (target, args: unknown[], newTarget) => Reflect.construct(target, fill(args), newTarget),
    });
}

/**
 * Formatting without an explicit locale uses the process's ICU default (LANG at start),
 * which a test cannot change. For the renders, a missing locale means en-US: the
 * formatters and the toLocale*String methods get it filled in, nothing else changes.
 */
function pinDefaultLocale(): () => void {
    const saved = {
        dateTimeFormat: Intl.DateTimeFormat,
        numberFormat: Intl.NumberFormat,
        dateString: Date.prototype.toLocaleString,
        dateDate: Date.prototype.toLocaleDateString,
        dateTime: Date.prototype.toLocaleTimeString,
        numberString: Number.prototype.toLocaleString,
    };
    Intl.DateTimeFormat = withDefaultLocale(saved.dateTimeFormat);
    Intl.NumberFormat = withDefaultLocale(saved.numberFormat);
    Date.prototype.toLocaleString = withDefaultLocale(saved.dateString);
    Date.prototype.toLocaleDateString = withDefaultLocale(saved.dateDate);
    Date.prototype.toLocaleTimeString = withDefaultLocale(saved.dateTime);
    Number.prototype.toLocaleString = withDefaultLocale(saved.numberString);
    return () => {
        Intl.DateTimeFormat = saved.dateTimeFormat;
        Intl.NumberFormat = saved.numberFormat;
        Date.prototype.toLocaleString = saved.dateString;
        Date.prototype.toLocaleDateString = saved.dateDate;
        Date.prototype.toLocaleTimeString = saved.dateTime;
        Number.prototype.toLocaleString = saved.numberString;
    };
}

function emptyResult(kind: unknown): unknown {
    return kind === 'record' ? null : [];
}

/**
 * Every binding on the screen answered with an empty result, under the key the fetch
 * layer (AppDataScope's BindingFetcher) would store it under for the same scope.
 */
export function emptyDataState(definition: CorpusDefinition, screen: CorpusScreen): DataState {
    const screenRoot = { params: {}, id: screen.id, name: screen.name };
    const scope = {
        currentUser: VIEWER,
        // The headless entry's starting values: defaults, then the derived variables (schema 3).
        vars: initialVariableValues(definition.variables, { currentUser: VIEWER, forms: {}, screen: screenRoot, today: FIXED_NOW.slice(0, 10) }),
        forms: {},
        screen: screenRoot,
        now: FIXED_NOW,
        today: FIXED_NOW.slice(0, 10),
    };
    const out: DataState = {};
    for (const { binding } of collectDataBindings(definition as never, screen.id)) {
        const b = binding as Binding;
        const resolved = b.kind === 'connector'
            ? resolveBindingParams(b, scope)
            : resolveBindingParams(resolveBindingFilters(resolveBindingShape(b, scope), scope), scope);
        const key = dataCacheKey(resolved);
        if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue;
        const entry: DataEntry = {
            status: 'success', result: emptyResult(b.kind), error: null, errorCode: null, errorProvider: null,
            tableId: (b as { tableId?: string }).tableId ?? null,
            datasetId: (b as { datasetId?: string }).datasetId ?? null,
            connectorId: (b as { connectorId?: string }).connectorId ?? null,
        };
        out[key] = entry;
    }
    return out;
}

/** Mount one screen through the headless entry and let lazy parts and effects settle. */
export async function renderScreen(definition: CorpusDefinition, screen: CorpusScreen, { chrome = false }: { chrome?: boolean } = {}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let handle: { unmount: () => void } | null = null;
    await act(async () => {
        handle = await mount(container, {
            definition,
            screenId: screen.id,
            dataState: emptyDataState(definition, screen),
            currentUser: VIEWER,
            previewRole: null,
            ...(chrome ? { screenshot: { chrome: true } } : {}),
        });
    });
    // Two more turns for React.lazy parts (icons outside the registry) to resolve.
    for (let i = 0; i < 2; i += 1) {
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    return {
        container,
        unmount: () => {
            act(() => { handle?.unmount(); });
            container.remove();
        },
    };
}

// ── The DOM as text ─────────────────────────────────────────────────────────

const REACT_ID = /«r[0-9a-z]+»|:r[0-9a-z]+:|_r_[0-9a-z]+_/g;
/**
 * dnd-kit numbers its accessibility nodes (DndDescribedBy-<n>, DndLiveRegion-<n>) with a
 * counter per process, so the number depends on how many boards rendered earlier in the same
 * test file. They are renumbered per screen, per prefix, in order of appearance.
 */
const DND_KIT_ID = /\bDnd[A-Za-z]+-\d+\b/g;

/** `value` with every per-process counter in it renumbered through `ids` (one map per screen). */
function renumberIds(value: string, ids: Map<string, string>): string {
    const react = value.replace(REACT_ID, (m) => {
        if (!ids.has(m)) ids.set(m, `<id-${[...ids.keys()].filter((k) => !k.startsWith('dnd:')).length + 1}>`);
        return ids.get(m) as string;
    });
    return react.replace(DND_KIT_ID, (m) => {
        const key = `dnd:${m}`;
        if (!ids.has(key)) {
            const prefix = m.slice(0, m.lastIndexOf('-'));
            const taken = [...ids.keys()].filter((k) => k.startsWith(`dnd:${prefix}-`)).length;
            ids.set(key, `${prefix}-<${taken + 1}>`);
        }
        return ids.get(key) as string;
    });
}

/**
 * Dates and times as the runtime prints them depend on the time zone and locale of the
 * process running the test (a vitest worker cannot change either: worker threads never
 * re-run tzset, and the ICU locale is fixed at start), so they are masked. What is left
 * is where a date shows, not how the machine formats it.
 */
const DATE_TIME_PATTERNS: ReadonlyArray<[RegExp, string]> = [
    [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?/g, '<datetime>'],
    [/\b\d{4}-\d{2}-\d{2}\b/g, '<date>'],
    [/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, '<date>'],
    [/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?/g, '<time>'],
];

function maskDates(text: string): string {
    let out = text;
    for (const [re, token] of DATE_TIME_PATTERNS) out = out.replace(re, token);
    return out;
}

function isDroppedClass(token: string): boolean {
    return token.startsWith('bfa-') || token.startsWith('u-');
}

/**
 * The inline declarations as the style attribute serialises them (the shorthands React
 * set, not jsdom's longhand expansion), one per property, sorted. A declaration never
 * holds a `;` outside a url() or a string here, and the runtime writes neither inline.
 */
function styleText(el: Element): string | null {
    const raw = el.getAttribute('style');
    if (!raw) return null;
    const decls = raw.split(';').map((d) => d.trim()).filter(Boolean).sort();
    return decls.length ? decls.join('; ') : null;
}

function attributeLines(el: Element, ids: Map<string, string>): string[] {
    const mapIds = (v: string) => renumberIds(v, ids);
    const out: string[] = [];
    const names = el.getAttributeNames().filter((n) => n !== 'class' && n !== 'style').sort();
    const classes = (el.getAttribute('class') || '').split(/\s+/).filter((t) => t && !isDroppedClass(t)).sort();
    if (classes.length) out.push(`class="${classes.join(' ')}"`);
    for (const n of names) out.push(`${n}="${maskDates(mapIds(el.getAttribute(n) ?? ''))}"`);
    const style = styleText(el);
    if (style) out.push(`style="${style}"`);
    return out;
}

function collapse(text: string): string {
    return maskDates(text.replace(/\s+/g, ' ').trim());
}

function walk(node: Node, depth: number, lines: string[], ids: Map<string, string>) {
    const pad = '  '.repeat(depth);
    if (node.nodeType === Node.TEXT_NODE) {
        const text = collapse(node.textContent || '');
        if (text) lines.push(`${pad}"${text}"`);
        return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    const attrs = attributeLines(el, ids);
    lines.push(`${pad}<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`);
    if (tag === 'svg') return;
    for (const child of Array.from(el.childNodes)) walk(child, depth + 1, lines, ids);
}

/** The rendered DOM under `root` as indented text (see the header for what is normalised). */
export function describeDom(root: Element, ids: Map<string, string> = new Map()): string {
    const lines: string[] = [];
    for (const child of Array.from(root.childNodes)) walk(child, 0, lines, ids);
    return lines.join('\n');
}

/**
 * Component types that crash in the headless entry TODAY, with the reason. The crash
 * shows in the snapshot (the error card is part of the DOM); any other crash fails.
 * The list may only shrink.
 */
export const KNOWN_HEADLESS_CRASHES: Readonly<Record<string, string>> = {
    input_dataset: 'useStudioLargeDatasets calls useQuery, and the headless entry mounts no QueryClientProvider',
};

/** The node types whose error boundary caught a crash, in document order. */
export function crashedNodes(root: Element): string[] {
    return Array.from(root.querySelectorAll('[data-app-node-error]')).map((el) => el.getAttribute('data-app-node-error') || 'unknown');
}

/**
 * Body nodes that are not a portal of the screen: recharts appends one hidden span to measure
 * text the first time ANY chart renders and keeps it for the rest of the process, so whether it
 * is there depends on which app ran earlier in the same file, not on the app being described.
 */
const NOT_A_PORTAL_IDS: ReadonlySet<string> = new Set(['recharts_measurement_span']);

/** Portals (open dialogs, live regions) land on document.body, outside the container. */
function strayBodyNodes(container: Element): Element[] {
    return Array.from(document.body.children).filter((el) => el !== container && !NOT_A_PORTAL_IDS.has(el.id));
}

/** The snapshot text for one corpus app: every screen in definition order. */
export async function describeApp(name: string): Promise<{ text: string; crashed: string[] }> {
    const file = loadCorpusFile(name);
    const definition = file.definition;
    const chrome = file.about?.lookChrome === true;
    const parts: string[] = [`# ${name}`];
    const crashed: string[] = [];
    for (const screen of definition.screens || []) {
        const { container, unmount } = await renderScreen(definition, screen, { chrome });
        try {
            const broken = crashedNodes(container);
            for (const type of broken) crashed.push(`${screen.id}: ${type}`);
            // React numbers its ids per process, so they are renumbered per screen.
            const ids = new Map<string, string>();
            parts.push(`## screen ${screen.id}${screen.name ? ` (${screen.name})` : ''}`);
            parts.push(describeDom(container, ids));
            for (const el of strayBodyNodes(container)) {
                parts.push('### outside the screen (portal)');
                const holder = document.createElement('div');
                holder.appendChild(el.cloneNode(true));
                parts.push(describeDom(holder, ids));
            }
        } finally {
            unmount();
        }
    }
    return { text: `${parts.join('\n')}\n`, crashed };
}

/** The committed snapshot path for one corpus app. */
export function snapshotPath(name: string): string {
    return path.join(SNAPSHOT_DIR, `${name}.txt`);
}

/**
 * The suite of one shard: each of its corpus apps renders with no crashed node and
 * matches its committed snapshot. The corpus is split over several test files so no
 * single file runs long; the snapshot is per app, so the split can change freely.
 */
export function defineLookShard(index: number, count: number) {
    const names = shardNames(corpusNames(), index, count);
    describe(`look regression: corpus apps render as captured (shard ${index + 1} of ${count})`, () => {
        let restoreClock: () => void = () => {};
        let restoreFetch: () => void = () => {};
        beforeAll(() => { restoreClock = fixedClock(); restoreFetch = noSession(); });
        afterAll(() => { restoreFetch(); restoreClock(); });

        it('has corpus apps to render', () => {
            expect(names.length).toBeGreaterThan(0);
        });

        for (const name of names) {
            it(name, async () => {
                const { text, crashed } = await describeApp(name);
                const unexpected = crashed.filter((c) => !Object.hasOwn(KNOWN_HEADLESS_CRASHES, c.slice(c.indexOf(': ') + 2)));
                expect(unexpected, `${name}: a node's error boundary caught a crash`).toEqual([]);
                await expect(text).toMatchFileSnapshot(snapshotPath(name));
            });
        }
    });
}
