// @vitest-environment node
/**
 * The real thing, end to end: the runtime bundle vite.cmsReactRuntime.mjs
 * builds (React 19, production), a component compiled by the shared compiler
 * on esbuild-wasm, and the frame document buildReactFrameDoc writes, run in a
 * jsdom window that executes the document's scripts the way the sandboxed
 * frame does. Proves the require shim, the mount, the props message, the
 * height report and the error path.
 */
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild-wasm';
import { describe, it, expect } from 'vitest';
import runtime from 'virtual:cms-react-runtime';
import { compileReactBlock } from '@shared/cmsReact/compile.mjs';
import { buildReactFrameDoc, themeCss, readSiteTheme, type FrameMode } from '../frameDoc';

type Posted = { type?: string; height?: number; message?: string; stack?: string };

// jsdom ships no types of its own; this is the part the test uses.
interface JsdomOptions { runScripts: 'dangerously'; pretendToBeVisual: boolean; beforeParse: (w: Window) => void }
type JsdomCtor = new (html: string, opts: JsdomOptions) => { window: Window & typeof globalThis };
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: JsdomCtor };

async function compile(source: string): Promise<string> {
    const result = await compileReactBlock(esbuild, source);
    if (!result.ok) throw new Error(result.error);
    return result.code;
}

/** Load a frame document; every message the frame posts to its parent (here: itself) is collected. */
function loadFrame(compiled: string, props: Record<string, unknown>, mode: FrameMode = 'public') {
    const posted: Posted[] = [];
    const html = buildReactFrameDoc({ runtime, compiled, theme: themeCss(readSiteTheme(null)), props, mode });
    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.addEventListener('message', (e: MessageEvent) => posted.push(e.data as Posted));
        },
    });
    return { dom, posted };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > ms) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
}

const COUNTER = `
import { useState } from 'react';
export default function Counter({ label }: { label: string }) {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>{label}: {n}</button>;
}`;

describe('cms react runtime (built bundle in jsdom)', () => {
    it('is a self-contained IIFE: no CDN, no import, no development build', () => {
        expect(runtime.startsWith('(function')).toBe(true);
        expect(runtime).not.toMatch(/esm\.sh|unpkg|jsdelivr/);
        expect(runtime).not.toMatch(/<\/script/i);
        expect(runtime).not.toContain('process.env');
    });

    it('mounts a compiled component, keeps its state across new props, and reports its height', async () => {
        const { dom, posted } = loadFrame(await compile(COUNTER), { label: 'Clicks' });
        const doc = dom.window.document;
        await until(() => doc.querySelector('button') !== null);
        const button = doc.querySelector('button') as HTMLButtonElement;
        expect(button.textContent).toBe('Clicks: 0');

        button.click();
        await until(() => button.textContent === 'Clicks: 1');

        dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
            data: { type: 'bf-react-props', props: { label: 'Taps' } },
            source: dom.window,
        }));
        await until(() => doc.querySelector('button')?.textContent === 'Taps: 1');

        await until(() => posted.some((m) => m.type === 'bf-react-resize'));
        const resize = posted.find((m) => m.type === 'bf-react-resize');
        expect(typeof resize?.height).toBe('number');
        dom.window.close();
    });

    it('ignores a props message that does not come from the parent window', async () => {
        const { dom } = loadFrame(await compile(COUNTER), { label: 'Clicks' });
        const doc = dom.window.document;
        await until(() => doc.querySelector('button') !== null);
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
            data: { type: 'bf-react-props', props: { label: 'Spoofed' } },
            source: null,
        }));
        await new Promise((r) => setTimeout(r, 50));
        expect(doc.querySelector('button')?.textContent).toBe('Clicks: 0');
        dom.window.close();
    });

    it('refuses an import outside the allowed list with a clear error', async () => {
        // The compiler already refuses it; a hand-made body proves the shim does too.
        const { dom, posted } = loadFrame('var x = require("lodash"); module.exports.default = function () { return null; };', {}, 'editor');
        await until(() => posted.some((m) => m.type === 'bf-react-error'));
        const err = posted.find((m) => m.type === 'bf-react-error');
        expect(err?.message).toContain('"lodash" is not available');
        expect(err?.message).toContain('react-dom/client');
        expect(dom.window.document.querySelector('.bf-react-error')?.textContent).toContain('lodash');
        dom.window.close();
    });

    it('a render error: reported, shown with its stack in editor mode, nothing rendered in public mode', async () => {
        const broken = await compile('export default function Broken() { throw new Error("kaput"); }');

        const editor = loadFrame(broken, {}, 'editor');
        await until(() => editor.posted.some((m) => m.type === 'bf-react-error'));
        expect(editor.posted.find((m) => m.type === 'bf-react-error')?.message).toBe('kaput');
        await until(() => editor.dom.window.document.querySelector('#root .bf-react-error') !== null);
        expect(editor.dom.window.document.querySelector('#root .bf-react-error pre')?.textContent).toContain('Error');
        editor.dom.window.close();

        const pub = loadFrame(broken, {}, 'public');
        await until(() => pub.posted.some((m) => m.type === 'bf-react-error'));
        await new Promise((r) => setTimeout(r, 30));
        expect(pub.dom.window.document.getElementById('root')?.innerHTML).toBe('');
        expect(pub.dom.window.document.querySelector('.bf-react-error')).toBeNull();
        pub.dom.window.close();
    });
});
