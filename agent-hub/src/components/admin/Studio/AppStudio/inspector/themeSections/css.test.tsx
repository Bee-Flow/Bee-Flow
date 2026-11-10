import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import entry from './css';
import { THEME_SECTIONS } from '../themeSections';
import { setAppCssOff } from '../../runtime/appCssSwitch';
import AppCustomCss from '../../runtime/AppCustomCss';
import { EditorChromeContext } from '../../editor/EditorChromeContext';
import type { EditorChromeValue } from '../../editor/EditorChromeContext';
import type { AppDefinition } from '../appDefinition';

const { Section } = entry;

function Harness({ initial, disabled = false }: { initial: AppDefinition; disabled?: boolean }) {
    const [definition, setDefinition] = useState(initial);
    return (
        <EditorChromeContext.Provider value={{ appId: 'app_1' } as EditorChromeValue}>
            <Section definition={definition} onCommit={setDefinition} disabled={disabled} screenId="scr_home" />
            <main data-testid="canvas"><AppCustomCss definition={definition} /></main>
            <output data-testid="definition">{JSON.stringify(definition)}</output>
        </EditorChromeContext.Provider>
    );
}

const stored = (): AppDefinition => JSON.parse(screen.getByTestId('definition').textContent || '{}');
const sheet = () => screen.getByTestId('canvas').querySelector('style');

afterEach(() => act(() => setAppCssOff('app_1', false)));

describe('the Custom CSS section of the theme panel', () => {
    it('is drawn by the panel, after the sections with a lower order', () => {
        expect(THEME_SECTIONS.find((s) => s.name === 'css')?.Section).toBe(Section);
        expect(entry.order).toBe(200);
    });

    it('writes design.customCss as you type and the canvas applies it', async () => {
        render(<Harness initial={{ design: { font: 'inter' } }} />);
        expect(sheet()).toBeNull();
        await userEvent.click(screen.getByLabelText('Stylesheet'));
        await userEvent.paste('.u-hero { color: red; }');
        expect(stored().design).toEqual({ font: 'inter', customCss: '.u-hero { color: red; }' });
        expect(sheet()?.textContent).toContain('.u-hero { color: red; }');
        expect(screen.getByTestId('form-style-css-count').textContent).toContain('20,000');
    });

    it('removes the key when the field is emptied', async () => {
        render(<Harness initial={{ design: { font: 'inter', customCss: '.a{}' } }} />);
        await userEvent.clear(screen.getByLabelText('Stylesheet'));
        expect(stored().design).toEqual({ font: 'inter', customCss: null });
        expect(sheet()).toBeNull();
    });

    it('names what the sanitiser takes out, in the app\'s words', () => {
        render(<Harness initial={{ design: { customCss: '@import "x"; .a { background: url(/api/users/me); position: fixed } .b { background: image-set(var(--x) 1x) }' } }} />);
        const warning = screen.getByTestId('form-style-css-removed');
        expect(warning.textContent).toContain('Left out when the app is shown:');
        for (const label of ['@import', 'an address that is not an inline image or an uploaded file of this app', 'position: fixed', 'an image address taken from a variable']) {
            expect(warning.textContent).toContain(label);
        }
    });

    it('lists the selectors that are a contract, with the screen on the canvas filled in', async () => {
        render(<Harness initial={{}} />);
        await userEvent.click(screen.getByRole('button', { name: 'What you can target' }));
        const contract = screen.getByTestId('app-css-contract').textContent || '';
        for (const selector of ['[data-app-screen="scr_home"]', '[data-section-id="sec_…"]', '[data-node-id="cmp_…"]', '[data-app-type="button"]', '.u-name', '[data-app-dark="true"]']) {
            expect(contract).toContain(selector);
        }
    });

    it('"CSS off" takes the stylesheet off the canvas without touching the definition', async () => {
        render(<Harness initial={{ design: { customCss: '.a{color:red}' } }} />);
        expect(sheet()).not.toBeNull();
        const before = screen.getByTestId('definition').textContent;
        await userEvent.click(screen.getByRole('checkbox', { name: 'CSS off' }));
        expect(sheet()).toBeNull();
        expect(screen.getByTestId('definition').textContent).toBe(before);
        await userEvent.click(screen.getByRole('checkbox', { name: 'CSS off' }));
        expect(sheet()).not.toBeNull();
    });

    it('is read-only while the editor is locked', () => {
        render(<Harness initial={{ design: { customCss: '.a{}' } }} disabled />);
        expect(screen.getByLabelText('Stylesheet')).toBeDisabled();
    });
});
