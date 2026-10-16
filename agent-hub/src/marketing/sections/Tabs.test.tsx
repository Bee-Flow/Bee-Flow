/**
 * Tabs section: ARIA wiring, keyboard, ?tab= deep link, and that every tab's
 * text is in the DOM (hidden, not unmounted).
 *
 * Run: cd agent-hub && npx vitest run src/marketing/sections/Tabs.test.tsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach } from 'vitest';
import Tabs from './Tabs';

const data = {
    enabled: true,
    title: 'For every team',
    items: [
        { tabId: 'it', label: 'IT', title: 'IT heading', body: 'IT body', cta: { label: 'Read more', link: { href: '/security' } } },
        { tabId: 'legal', label: 'Legal', title: 'Legal heading', body: 'Legal body' },
        { tabId: 'dpo', label: 'DPO', title: 'DPO heading', body: 'DPO body' },
    ],
};

afterEach(() => window.history.replaceState({}, '', '/'));

describe('Tabs', () => {
    it('is a tablist with one selected tab and roving tabindex', () => {
        render(<Tabs data={data} />);
        const tabs = screen.getAllByRole('tab');
        expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
        expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
        const panel = document.getElementById(tabs[0].getAttribute('aria-controls') || '');
        expect(panel?.getAttribute('role')).toBe('tabpanel');
        expect(panel?.getAttribute('aria-labelledby')).toBe(tabs[0].id);
    });

    it('renders a tab cta as a secondary button unless its style says otherwise', () => {
        const { container } = render(<Tabs data={data} />);
        const cta = container.querySelector('.tabs-panel-cta a');
        expect(cta?.className).toContain('btn-secondary');
        expect(cta?.className).not.toContain('btn-primary');
    });

    it('keeps every tab\'s text in the DOM, hiding only the inactive panels', () => {
        const { container } = render(<Tabs data={data} />);
        expect(container.textContent).toContain('Legal body');
        const panels = container.querySelectorAll('[role="tabpanel"]');
        expect([...panels].map((p) => (p as HTMLElement).hidden)).toEqual([false, true, true]);
    });

    it('switches with a click and writes ?tab= without dropping other parameters', async () => {
        window.history.replaceState({}, '', '/?preview=1');
        render(<Tabs data={data} />);
        await userEvent.click(screen.getByRole('tab', { name: 'Legal' }));
        expect(screen.getByRole('tab', { name: 'Legal' }).getAttribute('aria-selected')).toBe('true');
        expect(window.location.search).toContain('tab=legal');
        expect(window.location.search).toContain('preview=1');
    });

    it('moves with the arrow keys and Home/End, focusing the new tab', async () => {
        render(<Tabs data={data} />);
        screen.getByRole('tab', { name: 'IT' }).focus();
        await userEvent.keyboard('{ArrowRight}');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Legal' }));
        await userEvent.keyboard('{End}');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'DPO' }));
        await userEvent.keyboard('{ArrowRight}');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'IT' }));
    });

    it('opens the tab named by ?tab= on load', () => {
        window.history.replaceState({}, '', '/?tab=dpo');
        render(<Tabs data={data} />);
        expect(screen.getByRole('tab', { name: 'DPO' }).getAttribute('aria-selected')).toBe('true');
    });

    it('ignores an unknown ?tab= and renders the CTA as a link', () => {
        window.history.replaceState({}, '', '/?tab=zzz');
        render(<Tabs data={data} />);
        expect(screen.getByRole('tab', { name: 'IT' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('link', { name: 'Read more', hidden: true }).getAttribute('href')).toBe('/security');
    });

    it('makes a panel without a link focusable, and leaves one with a button alone', () => {
        const { container } = render(<Tabs data={data} />);
        const panels = [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
        expect(panels[0].hasAttribute('tabindex')).toBe(false);
        expect(panels[1].getAttribute('tabindex')).toBe('0');
    });

    it('renders nothing when disabled or without tabs', () => {
        expect(render(<Tabs data={{ ...data, enabled: false }} />).container.innerHTML).toBe('');
        expect(render(<Tabs data={{ enabled: true, items: [] }} />).container.innerHTML).toBe('');
    });
});
