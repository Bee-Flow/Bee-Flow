import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AppCustomCss from './AppCustomCss';
import AppRenderer from './AppRenderer';
import { setAppCssOff } from './appCssSwitch';
import { assetUrl } from './assets/assetUrl';
import { EditorChromeContext } from '../editor/EditorChromeContext';
import type { EditorChromeValue } from '../editor/EditorChromeContext';
import type { AppDefinition } from '../inspector/appDefinition';
import type { ReactNode } from 'react';

const CSS = '.u-hero { color: red; }';
const styled = (extra: Record<string, unknown> = {}) => ({ design: { font: 'inter', customCss: CSS }, ...extra });

/** The host element every real mount gives the component: its parent is the stylesheet's root. */
function mount(node: ReactNode) {
    const view = render(<main data-testid="root">{node}</main>);
    const root = view.container.firstElementChild as HTMLElement;
    return { ...view, root, sheet: () => root.querySelector('style[data-app-custom-css]') };
}

const inEditor = (appId: string, node: ReactNode) => (
    <EditorChromeContext.Provider value={{ appId } as EditorChromeValue}>{node}</EditorChromeContext.Provider>
);

afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    act(() => setAppCssOff('app_1', false));
});

describe('AppCustomCss', () => {
    it('leaves an app without a stylesheet exactly as it was', () => {
        const { root } = mount(<AppCustomCss definition={{ design: { font: 'inter' } }} />);
        expect(root.outerHTML).toBe('<main data-testid="root"></main>');
        expect(mount(<AppCustomCss definition={null} />).root.innerHTML).toBe('');
    });

    it('mounts the sanitised text in a scope and marks its parent as the root', () => {
        const { root, sheet } = mount(<AppCustomCss definition={styled()} />);
        expect(sheet()?.textContent).toBe(`.app-shell:has([data-app-css-root]) { position: relative; overflow: clip; }\n@scope ([data-app-css-root]) {\n${CSS}\n}`);
        expect(root.getAttribute('data-app-css-root')).toBe('');
        expect(root.getAttribute('data-app-dark')).toBe('false');
    });

    it('sanitises again whatever the definition holds', () => {
        const hostile = { design: { customCss: '@import "x"; .a { background: url(/api/users/me); color: blue } </style>' } };
        const text = mount(<AppCustomCss definition={hostile} />).sheet()?.textContent ?? '';
        expect(text).toContain('color: blue');
        for (const gone of ['@import', '/api/users', '</']) expect(text).not.toContain(gone);
    });

    it('says whether the app shows dark: its own appearance, else the host theme', () => {
        expect(mount(<AppCustomCss definition={styled({ theme: { appearance: 'dark' } })} />).root.getAttribute('data-app-dark')).toBe('true');
        document.documentElement.setAttribute('data-theme', 'dark');
        expect(mount(<AppCustomCss definition={styled({ theme: { appearance: 'light' } })} />).root.getAttribute('data-app-dark')).toBe('false');
        expect(mount(<AppCustomCss definition={styled({ theme: { appearance: 'auto' } })} />).root.getAttribute('data-app-dark')).toBe('true');
    });

    it('is not applied under the high-contrast host theme, and comes back after it', async () => {
        document.documentElement.setAttribute('data-theme', 'high-contrast');
        const { root, sheet } = mount(<AppCustomCss definition={styled()} />);
        expect(sheet()).toBeNull();
        expect(root.hasAttribute('data-app-css-root')).toBe(false);
        expect(root.hasAttribute('data-app-dark')).toBe(false);
        act(() => document.documentElement.setAttribute('data-theme', 'light'));
        await waitFor(() => expect(sheet()).not.toBeNull());
        expect(root.hasAttribute('data-app-css-root')).toBe(true);
        act(() => document.documentElement.setAttribute('data-theme', 'high-contrast'));
        await waitFor(() => expect(sheet()).toBeNull());
        expect(root.hasAttribute('data-app-css-root')).toBe(false);
    });

    it('"CSS off" switches it off in the editor of that app only', () => {
        const editor = mount(inEditor('app_1', <AppCustomCss definition={styled()} />));
        const other = mount(inEditor('app_2', <AppCustomCss definition={styled()} />));
        const runView = mount(<AppCustomCss definition={styled()} appId="app_1" />);
        act(() => setAppCssOff('app_1', true));
        expect(editor.sheet()).toBeNull();
        expect(editor.root.hasAttribute('data-app-css-root')).toBe(false);
        expect(other.sheet()).not.toBeNull();
        expect(runView.sheet()).not.toBeNull();
        act(() => setAppCssOff('app_1', false));
        expect(editor.sheet()).not.toBeNull();
    });

    it('resolves an uploaded file by the app id or the public page token', () => {
        const definition = { design: { customCss: '.a { background: url(asset:bg1); }' } };
        expect(mount(<AppCustomCss definition={definition} appId="app_1" />).sheet()?.textContent).toContain(`url(${assetUrl('asset:bg1', { appId: 'app_1' })})`);
        expect(mount(<AppCustomCss definition={definition} appId="app_1" publicToken="tok" />).sheet()?.textContent).toContain('/api/public-app/tok/assets/bg1)');
        expect(mount(inEditor('app_9', <AppCustomCss definition={definition} />)).sheet()?.textContent).toContain('/api/studio-apps/app_9/assets/bg1)');
        // Without an address the reference stays as written: the browser loads nothing for it.
        expect(mount(<AppCustomCss definition={definition} />).sheet()?.textContent).toContain('url(asset:bg1)');
    });

    it('takes its marks off the root when it unmounts', () => {
        const { root, unmount, rerender } = mount(<AppCustomCss definition={styled()} />);
        rerender(<main data-testid="root"><AppCustomCss definition={{ design: { font: 'inter' } }} /></main>);
        expect(root.hasAttribute('data-app-css-root')).toBe(false);
        expect(root.hasAttribute('data-app-dark')).toBe(false);
        unmount();
    });
});

describe('node.cssClass on the canvas', () => {
    const app = (cssClass?: string) => ({
        schemaVersion: 3,
        meta: { name: 'x' },
        homeScreenId: 'scr_a',
        screens: [{ id: 'scr_a', name: 'A', sections: [{ id: 'sec_a', style: {}, children: [{ id: 'cmp_a', type: 'heading', props: { text: 'Hi' }, style: { span: 12 }, ...(cssClass ? { cssClass } : {}) }] }] }],
    } as unknown as AppDefinition);
    const cellClasses = (definition: AppDefinition) => render(<AppRenderer definition={definition} />).container.querySelector('[data-node-id="cmp_a"]')?.className ?? '';

    it('is the class u-<name> on the component cell, and no class at all without it', () => {
        const plain = cellClasses(app());
        expect(plain).not.toContain('u-');
        expect(cellClasses(app('hero'))).toBe(`${plain} u-hero`);
        // A name the canonicalizer would refuse is never rendered.
        expect(cellClasses(app('x" onload="'))).toBe(plain);
    });
});
