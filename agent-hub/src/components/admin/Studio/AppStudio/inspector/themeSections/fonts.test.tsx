import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import entry from './fonts';
import { THEME_SECTIONS } from '../themeSections';
import AppCustomCss from '../../runtime/AppCustomCss';
import { EditorChromeContext } from '../../editor/EditorChromeContext';
import type { EditorChromeValue } from '../../editor/EditorChromeContext';
import type { AppDefinition } from '../appDefinition';

const { Section } = entry;

function Harness({ initial }: { initial: AppDefinition }) {
    const [definition, setDefinition] = useState(initial);
    return (
        <EditorChromeContext.Provider value={{ appId: 'app_1' } as EditorChromeValue}>
            <Section definition={definition} onCommit={setDefinition} disabled={false} screenId="scr_home" />
            <main><AppCustomCss definition={definition} /></main>
            <output data-testid="definition">{JSON.stringify(definition)}</output>
        </EditorChromeContext.Provider>
    );
}

const stored = (): AppDefinition => JSON.parse(screen.getByTestId('definition').textContent || '{}');

afterEach(() => vi.unstubAllGlobals());

describe('the Fonts per role section of the theme panel', () => {
    it('is drawn by the panel', () => {
        expect(THEME_SECTIONS.find((s) => s.name === 'fonts')?.Section).toBe(Section);
    });

    it('sets a role, and "As today" on every role removes the key', async () => {
        render(<Harness initial={{ design: { font: 'inter' } }} />);
        await userEvent.selectOptions(screen.getByLabelText('Headings'), 'fraunces');
        expect(stored().design).toEqual({ font: 'inter', fonts: { heading: 'fraunces' }, preset: 'custom' });
        await userEvent.selectOptions(screen.getByLabelText('Headings'), '');
        expect(stored().design).toEqual({ font: 'inter', fonts: null, preset: 'custom' });
    });

    it('registers an uploaded font with the browser under its own family, from the app asset store', () => {
        const added: Array<{ family: string; source: unknown }> = [];
        class FakeFace {
            family: string;
            source: unknown;
            constructor(family: string, source: unknown) { this.family = family; this.source = source; }
            load() { return Promise.resolve(this); }
        }
        vi.stubGlobal('FontFace', FakeFace);
        const fonts = { add: (face: FakeFace) => added.push({ family: face.family, source: face.source }) };
        Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
        render(<Harness initial={{ design: { fonts: { heading: 'asset:brandfont', mono: 'fira-code' } } } as unknown as AppDefinition} />);
        expect(screen.getByLabelText('Headings')).toHaveValue('__uploaded__');
        expect(added).toHaveLength(1);
        expect(added[0].family).toBe('app-font-brandfont');
        expect(String(added[0].source)).toContain('/api/studio-apps/app_1/assets/brandfont');
        expect(String(added[0].source)).toContain('format("woff2")');
    });
});
