/**
 * The React runtime INSIDE the sandboxed frame of a `react-component` block.
 *
 * Never imported by the app: vite.cmsReactRuntime.mjs bundles this file (with
 * React 19 from agent-hub's own node_modules, production build, minified) into
 * one IIFE and hands the text to the renderer as `virtual:cms-react-runtime`.
 * The renderer inlines it into the frame's srcdoc, so a visitor's browser
 * fetches React from nobody: no CDN, no import map.
 *
 * The frame document then calls
 *
 *     __bfReactMount(function (module, exports, require) { COMPILED }, PROPS, OPTS)
 *
 * where COMPILED is the CommonJS body compileReactBlock (shared/cmsReact)
 * produced from the author's TSX. `require` resolves exactly ALLOWED_IMPORTS
 * and nothing else.
 *
 * Messages (the parent accepts only those from its own frame):
 *   frame -> parent  { type: 'bf-react-resize', height }
 *                    { type: 'bf-react-error', message, stack? }
 *   parent -> frame  { type: 'bf-react-props', props }  re-render, state kept
 *
 * Errors: render errors land in an error boundary; window errors and unhandled
 * rejections are reported too. In 'editor' mode the frame shows the message
 * and stack; in 'public' mode it renders nothing (the frame collapses to 0).
 */
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';
import { ALLOWED_IMPORTS } from '@shared/cmsReact/compile.mjs';

type Mode = 'public' | 'editor';
type Props = Record<string, unknown>;
interface MountOptions { mode?: string }
type ModuleRecord = { exports: Record<string, unknown> };
type Factory = (module: ModuleRecord, exports: Record<string, unknown>, require: (name: string) => unknown) => void;

declare global {
    interface Window { __bfReactMount?: (factory: Factory, props: unknown, opts?: MountOptions) => void }
}

const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;

/** react/jsx-dev-runtime has no jsxDEV in a production build; the compiler never emits it, an author may import it. */
const jsxDevRuntime = {
    Fragment: JsxRuntime.Fragment,
    jsxDEV: (type: React.ElementType, props: Props, key?: React.Key, isStatic?: boolean) =>
        (isStatic ? JsxRuntime.jsxs : JsxRuntime.jsx)(type, props, key),
};

const PROVIDED: Record<string, unknown> = {
    react: React,
    'react/jsx-runtime': JsxRuntime,
    'react/jsx-dev-runtime': jsxDevRuntime,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOMClient,
};

/** Exactly the modules the compiler lets through: one list, the shared one. */
const MODULES: Record<string, unknown> = Object.fromEntries(ALLOWED_IMPORTS.map((name) => [name, PROVIDED[name]]));

function requireModule(name: string): unknown {
    if (Object.prototype.hasOwnProperty.call(MODULES, name) && MODULES[name] !== undefined) return MODULES[name];
    throw new Error(`"${name}" is not available in a React component block. It may import only: ${ALLOWED_IMPORTS.join(', ')}.`);
}

/** The parent is opaque to this frame (no allow-same-origin), so the target origin can only be '*'; nothing secret is sent. */
function post(message: Record<string, unknown>): void {
    window.parent.postMessage(message, '*');
}

function describeError(err: unknown): { message: string; stack: string } {
    const e = err as { message?: unknown; stack?: unknown } | null;
    const message = String(e && typeof e === 'object' && 'message' in e ? e.message : err).slice(0, MAX_MESSAGE);
    const stack = e && typeof e === 'object' && typeof e.stack === 'string' ? e.stack.slice(0, MAX_STACK) : '';
    return { message, stack };
}

function reportError(err: unknown): void {
    const { message, stack } = describeError(err);
    post(stack ? { type: 'bf-react-error', message, stack } : { type: 'bf-react-error', message });
}

function errorPanel(err: unknown): React.ReactElement {
    const { message, stack } = describeError(err);
    return React.createElement('div', { className: 'bf-react-error', role: 'alert' },
        React.createElement('strong', null, message),
        stack ? React.createElement('pre', null, stack) : null);
}

/** Outside React: a factory that throws, or a window error after mount (editor mode only). */
function showPanel(err: unknown): void {
    let host = document.getElementById('bf-react-error');
    if (!host) {
        host = document.createElement('div');
        host.id = 'bf-react-error';
        document.body.appendChild(host);
    }
    const { message, stack } = describeError(err);
    host.className = 'bf-react-error';
    host.setAttribute('role', 'alert');
    host.textContent = '';
    const title = document.createElement('strong');
    title.textContent = message;
    host.appendChild(title);
    if (stack) {
        const pre = document.createElement('pre');
        pre.textContent = stack;
        host.appendChild(pre);
    }
}

interface BoundaryProps { mode: Mode; resetKey: number; children?: React.ReactNode }
interface BoundaryState { failed: { error: unknown } | null; resetKey: number }

class Boundary extends React.Component<BoundaryProps, BoundaryState> {
    state: BoundaryState = { failed: null, resetKey: this.props.resetKey };

    static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
        return { failed: { error } };
    }

    /** New props are a new chance: an error from the old ones is cleared. */
    static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
        return props.resetKey !== state.resetKey ? { failed: null, resetKey: props.resetKey } : null;
    }

    componentDidCatch(error: unknown): void {
        reportError(error);
    }

    render(): React.ReactNode {
        if (!this.state.failed) return this.props.children;
        return this.props.mode === 'editor' ? errorPanel(this.state.failed.error) : null;
    }
}

function loadComponent(factory: Factory): React.ElementType {
    const record: ModuleRecord = { exports: {} };
    factory(record, record.exports, requireModule);
    const exported = record.exports;
    const component = exported && typeof exported === 'object' ? exported.default : exported;
    const isElementType = typeof component === 'function'
        || (component !== null && typeof component === 'object' && '$$typeof' in component);
    if (!isElementType) {
        throw new Error('The component has no default export. Export the component to render: export default function Block(props) { … }');
    }
    return component as React.ElementType;
}

/** Report the document's height whenever it changes; 0 when nothing renders. */
function watchHeight(): () => void {
    let last = -1;
    const measure = () => {
        const body = document.body;
        if (!body) return;
        const height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height));
        if (height === last) return;
        last = height;
        post({ type: 'bf-react-resize', height });
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(document.body);
    window.addEventListener('load', measure);
    return measure;
}

function listenForErrors(mode: Mode): void {
    window.addEventListener('error', (e: ErrorEvent) => {
        const err = e.error ?? e.message;
        reportError(err);
        if (mode === 'editor') showPanel(err);
    });
    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
        reportError(e.reason);
        if (mode === 'editor') showPanel(e.reason);
    });
}

function asProps(value: unknown): Props {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Props) : {};
}

function mount(factory: Factory, initialProps: unknown, opts: MountOptions = {}): void {
    const mode: Mode = opts && opts.mode === 'editor' ? 'editor' : 'public';
    listenForErrors(mode);
    const measure = watchHeight();
    let Component: React.ElementType;
    try {
        Component = loadComponent(factory);
    } catch (err) {
        reportError(err);
        if (mode === 'editor') showPanel(err);
        measure();
        return;
    }
    const container = document.getElementById('root') || document.body.appendChild(document.createElement('div'));
    const root = ReactDOMClient.createRoot(container, { onUncaughtError: reportError });
    let props = asProps(initialProps);
    let resetKey = 0;
    const render = () => {
        root.render(React.createElement(Boundary, { mode, resetKey }, React.createElement(Component, props)));
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measure);
        else setTimeout(measure, 0);
    };
    window.addEventListener('message', (e: MessageEvent) => {
        if (e.source !== window.parent) return;
        const data = e.data as { type?: unknown; props?: unknown } | null;
        if (!data || data.type !== 'bf-react-props') return;
        props = asProps(data.props);
        resetKey += 1;
        render();
    });
    render();
}

window.__bfReactMount = mount;
