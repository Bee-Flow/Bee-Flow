import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import SectionChips from './SectionChips';
import type { AppSection } from '../inspector/appDefinition';

/** Real <section data-section-id> elements, as the renderer leaves them on the canvas. */
function mountSections(ids: string[]) {
    const host = document.createElement('div');
    host.setAttribute('data-app-edit', 'true');
    document.body.appendChild(host);
    const map = new Map<string | null | undefined, Element>();
    for (const id of ids) {
        const el = document.createElement('section');
        el.setAttribute('data-section-id', id);
        host.appendChild(el);
        map.set(id, el);
    }
    return { host, map };
}

afterEach(() => { document.body.innerHTML = ''; });

const SECTIONS: AppSection[] = [
    { id: 'sec_a', children: [] },
    { id: 'sec_b', name: 'Filters', children: [] },
    { id: 'sec_c', title: 'Open orders', visibleToRoles: ['manager'], children: [] },
    { id: 'sec_gone', children: [] },
];

describe('SectionChips', () => {
    it('puts a chip in every rendered section, labelled by name, title or position', () => {
        const { map } = mountSections(['sec_a', 'sec_b', 'sec_c']);
        render(<SectionChips sections={SECTIONS} sectionEls={map} selectedId={null} disabled={false} onSelect={vi.fn()} />);
        expect(map.get('sec_a')!.querySelector('[data-section-chip]')?.textContent).toBe('Section 1');
        expect(map.get('sec_b')!.querySelector('[data-section-chip]')?.textContent).toBe('Filters');
        expect(map.get('sec_c')!.querySelector('[data-section-chip]')?.textContent).toBe('Open orders');
        // A section the canvas did not render (role preview) gets no chip.
        expect(document.querySelectorAll('[data-section-chip]')).toHaveLength(3);
    });

    it('selects the section on click and rings the selected one', async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        const { map } = mountSections(['sec_a', 'sec_b']);
        const { rerender } = render(<SectionChips sections={SECTIONS} sectionEls={map} selectedId={null} disabled={false} onSelect={onSelect} />);
        await user.click(screen.getByRole('button', { name: 'Select section Filters' }));
        expect(onSelect).toHaveBeenCalledWith('sec_b');
        rerender(<SectionChips sections={SECTIONS} sectionEls={map} selectedId="sec_b" disabled={false} onSelect={onSelect} />);
        expect(screen.getByRole('button', { name: 'Select section Filters' })).toHaveAttribute('aria-pressed', 'true');
        expect(map.get('sec_b')!.querySelector('[data-section-ring]')).not.toBeNull();
        expect(map.get('sec_a')!.querySelector('[data-section-ring]')).toBeNull();
    });

    it('is disabled while the AI builds', () => {
        const { map } = mountSections(['sec_a']);
        render(<SectionChips sections={SECTIONS} sectionEls={map} selectedId={null} disabled onSelect={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Select section Section 1' })).toBeDisabled();
    });
});
