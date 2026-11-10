import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppCustomCss from './AppCustomCss';
import AppRenderer from './AppRenderer';
import AppSection from './AppSection';
import { DEFAULT_RUNTIME, useRuntime } from './RuntimeContext';
import { gridTemplate, resolveSectionStyle } from './styleResolver';
import type { AppDefinition } from '../inspector/appDefinition';
import type { ReactNode } from 'react';

/**
 * The dormant plumbing of the look track: each piece exists and changes nothing.
 */

describe('gridTemplate', () => {
    it('is the 12-column template when no column count is given', () => {
        for (const absent of [undefined, null, 0, 13, 2.5, Number.NaN]) {
            expect(gridTemplate(absent)).toBe('repeat(12, minmax(0, 1fr))');
        }
        expect(resolveSectionStyle({ style: {} }).style.gridTemplateColumns).toBe('repeat(12, minmax(0, 1fr))');
    });

    it('is that many equal columns for 1..12', () => {
        expect(gridTemplate(1)).toBe('repeat(1, minmax(0, 1fr))');
        expect(gridTemplate(5)).toBe('repeat(5, minmax(0, 1fr))');
        expect(gridTemplate(12)).toBe('repeat(12, minmax(0, 1fr))');
    });
});

describe('AppSection', () => {
    it('draws the section element the renderer used to write inline', () => {
        const section = { id: 'sec_a', style: { padding: 4, gap: 3, background: 'panel' } };
        const { container } = render(<AppSection section={section}><i data-testid="child" /></AppSection>);
        const el = container.firstElementChild as HTMLElement;
        const resolved = resolveSectionStyle(section);
        expect(el.tagName).toBe('SECTION');
        expect(el.getAttribute('data-section-id')).toBe('sec_a');
        expect(el.className).toBe(resolved.className);
        expect(el.style.gridTemplateColumns).toBe('repeat(12, minmax(0, 1fr))');
        expect(el.children).toHaveLength(1);
    });
});

describe('AppCustomCss', () => {
    it('renders nothing', () => {
        const { container } = render(<AppCustomCss definition={{ design: { font: 'inter' } }} />);
        expect(container.innerHTML).toBe('');
    });
});

describe('initialUi', () => {
    const seen: unknown[] = [];
    function Probe() {
        seen.push(useRuntime().initialUi);
        return null;
    }
    const definition = {
        schemaVersion: 2,
        meta: { name: 'x' },
        homeScreenId: 'scr_a',
        screens: [{ id: 'scr_a', name: 'A', sections: [{ id: 'sec_a', style: {}, children: [{ id: 'cmp_a', type: 'heading', props: { text: 'Hi' }, style: { span: 12 } }] }] }],
    } as unknown as AppDefinition;
    const Wrapper = ({ children }: { children?: ReactNode }) => <div><Probe />{children}</div>;

    it('is null unless a host passes one, and reaches the context as given', () => {
        expect(DEFAULT_RUNTIME.initialUi).toBeNull();
        render(<AppRenderer definition={definition} NodeWrapper={Wrapper} />);
        expect(seen.at(-1)).toBeNull();
        const initialUi = { cmp_a: { open: true } };
        render(<AppRenderer definition={definition} NodeWrapper={Wrapper} initialUi={initialUi} />);
        expect(seen.at(-1)).toBe(initialUi);
    });
});
