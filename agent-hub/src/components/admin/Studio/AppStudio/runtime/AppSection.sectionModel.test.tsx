import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import AppRenderer from './AppRenderer';
import type { AppDefinition } from '../inspector/appDefinition';

/**
 * The optional section keys in the renderer (AppSection + sectionModel): a title row, folding,
 * a width cap, a visibility rule and a role gate. A section without them is the element it
 * always was.
 */

const text = (id: string, t: string) => ({ id, type: 'text', props: { text: t }, style: { span: 12 } });

function defWith(sections: Record<string, unknown>[]): AppDefinition {
    return {
        schemaVersion: 3,
        meta: { name: 'Sections', description: '', icon: 'Rows3' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_t',
        roles: [{ id: 'manager', name: 'Manager' }],
        screens: [{
            id: 'scr_t', name: 'T', icon: null, showInNav: true, maxWidth: 'wide',
            sections: sections.map((s, i) => ({ id: `sec_t${i}`, style: { padding: 4, gap: 3, background: 'none' }, children: [text(`cmp_t${i}`, `Body ${i}`)], ...s })),
        }],
        actions: {},
    } as unknown as AppDefinition;
}

const sectionEl = (container: HTMLElement, i: number) => container.querySelector(`[data-section-id="sec_t${i}"]`);

describe('AppSection — the optional keys', () => {
    it('a section without them renders the plain grid element, as before', () => {
        const { container } = render(<AppRenderer definition={defWith([{}])} screenId="scr_t" />);
        const el = sectionEl(container, 0)!;
        expect(el.className).toBe('app-grid');
        expect(el.querySelector('header')).toBeNull();
        expect(el.children).toHaveLength(1);
    });

    it('a title is a heading row inside the section; maxWidth adds its cap class', () => {
        const { container } = render(<AppRenderer definition={defWith([{ title: 'Open orders', maxWidth: 'narrow' }, { maxWidth: 'full' }])} screenId="scr_t" />);
        const el = sectionEl(container, 0)!;
        expect(screen.getByRole('heading', { level: 2, name: 'Open orders' })).toBeInTheDocument();
        expect(el.firstElementChild?.className).toBe('app-section-header');
        expect(el.className.split(' ')).toEqual(expect.arrayContaining(['app-grid', 'app-section-max-narrow', 'app-section--titled']));
        expect(sectionEl(container, 1)!.className).toBe('app-grid');
    });

    it('collapsible folds the components away behind the title button', async () => {
        const user = userEvent.setup();
        const { container } = render(<AppRenderer definition={defWith([{ title: 'History', collapsible: true }])} screenId="scr_t" />);
        const toggle = screen.getByRole('button', { name: 'History' });
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByText('Body 0')).toBeInTheDocument();
        await user.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByText('Body 0')).toBeNull();
        expect(sectionEl(container, 0)!.className).toContain('app-section--collapsed');
        await user.click(toggle);
        expect(screen.getByText('Body 0')).toBeInTheDocument();
    });

    it('collapsible without a title does nothing (no button)', () => {
        render(<AppRenderer definition={defWith([{ collapsible: true }])} screenId="scr_t" />);
        expect(screen.queryByRole('button')).toBeNull();
        expect(screen.getByText('Body 0')).toBeInTheDocument();
    });

    it('visibleWhen false renders nothing in the app and a dimmed section in the editor', () => {
        const def = defWith([{ visibleWhen: { kind: 'formula', expr: "vars.view == 'archive'" } }, {}]);
        const run = render(<AppRenderer definition={def} screenId="scr_t" vars={{ view: 'open' }} />);
        expect(sectionEl(run.container, 0)).toBeNull();
        expect(run.queryByText('Body 0')).toBeNull();
        expect(sectionEl(run.container, 1)).not.toBeNull();
        run.unmount();

        const shown = render(<AppRenderer definition={def} screenId="scr_t" vars={{ view: 'archive' }} />);
        expect(shown.getByText('Body 0')).toBeInTheDocument();
        shown.unmount();

        const edit = render(<AppRenderer definition={def} screenId="scr_t" mode="edit" vars={{ view: 'open' }} />);
        expect(sectionEl(edit.container, 0)!.className).toContain('app-section--hidden-edit');
    });

    it('visibleToRoles hides the section from another role, never from the owner or the editor without a role', () => {
        const def = defWith([{ visibleToRoles: ['manager'] }]);
        const member = render(<AppRenderer definition={def} screenId="scr_t" previewRole="member" />);
        expect(sectionEl(member.container, 0)).toBeNull();
        member.unmount();
        for (const role of ['manager', 'owner', null]) {
            const r = render(<AppRenderer definition={def} screenId="scr_t" previewRole={role} />);
            expect(sectionEl(r.container, 0)).not.toBeNull();
            r.unmount();
        }
    });
});
