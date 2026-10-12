import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { clockTone, incidentPillText, REGISTER_SPECS, ropaPill, soaExportItems } from './registerSpecs';
import type { HeaderCtx, HeaderSpec } from './registerSpecs';

const t = (_key: string, fallback: string, vars: Record<string, unknown> = {}) =>
    fallback.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ''));

const BASE: HeaderSpec = { pill: <span data-testid="base-pill">95</span>, infoChip: null, secondary: null, primary: <span data-testid="base-primary">Run again</span>, tabCounts: {} };
const spec = (id: string, ctx: HeaderCtx, base: HeaderSpec = BASE) => REGISTER_SPECS[id](ctx, t, base);
const show = (node: ReactNode) => render(<>{node}</>);

const DAY = 86_400_000;
const NOW = new Date('2026-10-06T12:00:00Z').getTime();

describe('registerSpecs: ROPA', () => {
    it('says when the register was reviewed, or that a review is due or never happened', () => {
        const { unmount } = show(ropaPill(new Date(NOW - 30 * DAY).toISOString(), t, { now: NOW }));
        expect(screen.getByTestId('header-pill')).toHaveTextContent(/^Reviewed \d{1,2} \w{3}$/);
        expect(screen.getByTestId('header-pill')).toHaveAttribute('data-tone', 'neutral');
        unmount();
        const { unmount: u2 } = show(ropaPill(new Date(NOW - 400 * DAY).toISOString(), t, { now: NOW }));
        expect(screen.getByTestId('header-pill')).toHaveTextContent('Review overdue');
        expect(screen.getByTestId('header-pill')).toHaveAttribute('data-tone', 'warning');
        u2();
        show(ropaPill(null, t, { now: NOW }));
        expect(screen.getByTestId('header-pill')).toHaveTextContent('Never reviewed');
        expect(screen.getByTestId('header-pill')).toHaveAttribute('data-tone', 'warning');
    });

    it('offers regenerate (icon only, named) and "Mark as reviewed" once the page wired them', async () => {
        const regenerate = vi.fn();
        const markReviewed = vi.fn();
        const s = spec('ropa', { counts: { ropa: { last_reviewed_at: null } }, onRegenerateRopa: regenerate, onMarkRopaReviewed: markReviewed });
        show(<>{s.pill}{s.secondary}{s.primary}</>);
        expect(screen.getByTestId('header-pill')).toHaveTextContent('Never reviewed');
        const refresh = screen.getByRole('button', { name: 'Regenerate from live configuration' });
        expect(refresh).toHaveAttribute('title', 'Regenerate from live configuration');
        expect(refresh).not.toHaveTextContent(/\w/);
        await userEvent.click(refresh);
        expect(regenerate).toHaveBeenCalled();
        await userEvent.click(screen.getByRole('button', { name: 'Mark as reviewed' }));
        expect(markReviewed).toHaveBeenCalled();
    });

    it('renders no pill before the counts land and no buttons the page did not wire', () => {
        const s = spec('ropa', { counts: null });
        expect(s.pill).toBeNull();
        expect(s.secondary).toBeNull();
        expect(s.primary).toBeNull();
    });
});

describe('registerSpecs: portability, own frameworks, machinery', () => {
    it('portability: the coverage pill in tone, and a refresh', async () => {
        const refresh = vi.fn();
        const s = spec('portability', { portabilityCoverage: { portable: 9, total: 12 }, onRefreshPortability: refresh });
        show(<>{s.pill}{s.secondary}</>);
        expect(screen.getByTestId('header-pill')).toHaveTextContent('9 of 12 kinds portable');
        expect(screen.getByTestId('header-pill')).toHaveAttribute('data-tone', 'warning');
        await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(refresh).toHaveBeenCalled();
        expect(spec('portability', { portabilityCoverage: { portable: 12, total: 12 } }).pill).not.toBeNull();
        expect(spec('portability', { portabilityCoverage: null }).pill).toBeNull();
    });

    it('custom: "New framework" replaces the base primary once the page registered it; the rest stays', async () => {
        const add = vi.fn();
        const s = spec('custom', { onAddFramework: add });
        show(<>{s.pill}{s.primary}</>);
        expect(screen.getByTestId('base-pill')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'New framework' }));
        expect(add).toHaveBeenCalled();
        expect(spec('custom', {}).primary).toBe(BASE.primary);
    });

    it('machinery: "Scan again" from the page', async () => {
        const scan = vi.fn();
        show(spec('machinery', { onRefreshMachinery: scan }).primary);
        await userEvent.click(screen.getByRole('button', { name: 'Scan again' }));
        expect(scan).toHaveBeenCalled();
    });

    it('audits, policies and training take a generic primaryAction', async () => {
        const go = vi.fn();
        for (const id of ['audits', 'policies', 'training']) {
            const { unmount } = show(spec(id, { primaryAction: { label: `Go ${id}`, onClick: go } }).primary);
            await userEvent.click(screen.getByRole('button', { name: `Go ${id}` }));
            unmount();
            expect(spec(id, {}).primary).toBeNull();
        }
        expect(go).toHaveBeenCalledTimes(3);
    });
});

describe('registerSpecs: SoA export', () => {
    const ctx = (dl: HeaderCtx['dl']): HeaderCtx => ({ api: '/api/compliance', dl, counts: { soa: { approved: 9, total: 93 } } });

    it('lists the two downloads of the Export tab, only those dl let through', () => {
        expect(soaExportItems(ctx((u) => u), t).map(x => [x.id, x.href, x.label])).toEqual([
            ['soa_pdf', '/api/compliance/iso/soa.pdf', 'SoA (PDF)'],
            ['bundle', '/api/compliance/iso/evidence-bundle.zip', 'Evidence bundle (zip)'],
        ]);
        expect(soaExportItems(ctx(() => null), t)).toEqual([]);
        expect(soaExportItems(ctx(undefined), t)).toEqual([]);
    });

    it('one "Export" menu with the intro sentence and both links', async () => {
        show(spec('soa', ctx((u) => u)).primary);
        const button = screen.getByRole('button', { name: /Export/ });
        expect(button).toHaveAttribute('aria-haspopup', 'menu');
        await userEvent.click(button);
        const menu = screen.getByRole('menu');
        expect(menu).toHaveAccessibleDescription(/The SoA PDF lists all 93 Annex A decisions/);
        const items = within(menu).getAllByRole('menuitem');
        expect(items.map(a => a.textContent)).toEqual(['SoA (PDF)', 'Evidence bundle (zip)']);
        expect(items[0]).toHaveAttribute('href', '/api/compliance/iso/soa.pdf');
        expect(items[0]).toHaveAttribute('download');
        expect(items[0]).toHaveFocus();
    });

    it('with downloads off: disabled but focusable, and it says why', async () => {
        show(spec('soa', ctx(() => null)).primary);
        const button = screen.getByRole('button', { name: /Export/ });
        expect(button).toHaveAttribute('aria-disabled', 'true');
        expect(button).toHaveAccessibleDescription('Downloads are switched off in this workspace');
        await userEvent.tab();
        expect(button).toHaveFocus();
        expect(await screen.findByRole('tooltip')).toHaveTextContent('Downloads are switched off in this workspace');
        await userEvent.click(button);
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('keeps the progress pill and "Fill missing rows" only when the page can seed', () => {
        const s = spec('soa', { ...ctx((u) => u), soa: { soa: { stats: { todo: 43 } }, seed: vi.fn() } });
        show(<>{s.pill}{s.secondary}</>);
        expect(screen.getByTestId('header-pill')).toHaveTextContent('9 of 93 approved · 43 to review');
        expect(screen.getByRole('button', { name: 'Fill missing rows' })).toBeInTheDocument();
        expect(spec('soa', ctx((u) => u)).secondary).toBeNull();
    });
});

describe('registerSpecs: incident clock wording and tone', () => {
    it('follows the rail: due or past is an error, a day or less a warning, else neutral', () => {
        expect(clockTone(-1)).toBe('error');
        expect(clockTone(0)).toBe('error');
        expect(clockTone(24)).toBe('warning');
        expect(clockTone(25)).toBe('neutral');
    });

    it('names the stage, says overdue in so many words, and falls back without one', () => {
        expect(incidentPillText(1, 12, 'authority', t)).toBe('1 open · authority notice in 12 h');
        expect(incidentPillText(1, -2, 'early_warning', t)).toBe('1 open · early warning 2 h overdue');
        expect(incidentPillText(3, 8, 'something_new', t)).toBe('3 open · 8 h to the deadline');
        expect(incidentPillText(3, undefined, 'authority', t)).toBe('3 open');
    });
});
