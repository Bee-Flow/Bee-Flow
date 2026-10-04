import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GMAIL_CATALOG as CATALOG, scheduledStepProps as props } from './ndv/ndvTestProps';

/**
 * The node drawer's plumbing words — Pin/Pinned/Clear, Edit/Edited,
 * Disable/Disabled, Show/Hide input and output — were hardcoded English, and
 * six of the eight wrote the ternary around the STRING instead of around the
 * KEY, so half of each pair could never be reached by a translator.
 *
 * Hardcoded English and translated English render identically, so a plain
 * render proves nothing. Every assertion here therefore runs twice: once on
 * the shipped English, and once with a Dutch dictionary switched in over the
 * REAL useTranslation. The screen may only change if the string travels
 * through t(key, fallback) — and it is asserted for BOTH sides of every
 * ternary, because a ternary around the string leaves exactly one half
 * translated and the other half stuck in English.
 */
const { api } = vi.hoisted(() => ({
    api: {
        getCatalog: vi.fn(),
        listFormPages: vi.fn().mockResolvedValue({ forms: [] }),
    },
}));
vi.mock('../../../hooks/useAutomationApi', () => ({ default: () => api }));

const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
vi.mock('../../../hooks/useTranslation', async (importOriginal) =>
    (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

const NodeDetailView = (await import('./NodeDetailView')).default;

const gmailStep = (over = {}) => ({ id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: {}, ...over });
/** A step whose output is frozen — `pinnedOutput` present is what "pinned" means. */
const pinned = (over = {}) => gmailStep({ pinnedOutput: { ok: true }, pinnedAt: '2026-01-01T00:00:00.000Z', ...over });
/** Pinned AND typed by hand: `pinnedSource: 'edited'` is the second half. */
const edited = () => pinned({ pinnedSource: 'edited' });

const mount = async (step, extra) => {
    await act(async () => { render(<NodeDetailView {...props(step, extra)} />); });
};

/** Pin and Disable live in the header's ⋯ menu since round 4. */
const openMenu = async () => { await userEvent.click(screen.getByTestId('ndv-more-menu')); };

const NL = {
    'automations.ndv.pin': 'Vastzetten',
    'automations.ndv.pinned': 'Vastgezet',
    'automations.ndv.clear': 'Wissen',
    'automations.ndv.pin_title': 'Zet deze uitvoer vast',
    'automations.ndv.unpin_title': 'Uitvoer losmaken',
    'automations.ndv.edit': 'Bewerken',
    'automations.ndv.edited': 'Bewerkt',
    'automations.ndv.disable': 'Uitschakelen',
    'automations.ndv.disabled': 'Uitgeschakeld',
    'automations.ndv.disable_title': 'Schakel deze node uit',
    'automations.ndv.reenable_title': 'Schakel deze node weer in',
    'automations.ndv.show_input': 'Invoer tonen',
    'automations.ndv.hide_input': 'Invoer verbergen',
    'automations.ndv.show_output': 'Uitvoer tonen',
    'automations.ndv.hide_output': 'Uitvoer verbergen',
};

beforeEach(() => {
    cleanup();
    transOverride.current = null;
    api.getCatalog.mockResolvedValue(CATALOG);
    try { localStorage.clear(); } catch { /* ignore */ }
});

describe('NodeDetailView i18n — Pin / Unpin', () => {
    it('says Pin and its long title in English on an unpinned step', async () => {
        await mount(gmailStep());
        await openMenu();
        const btn = screen.getByTitle('Pin this output (skip live execution; reuse the latest output)');
        expect(btn.textContent).toContain('Pin');
    });

    it('says Pinned and the Unpin title in English on a pinned step', async () => {
        await mount(pinned());
        await openMenu();
        const btn = screen.getByTitle('Unpin output (re-enable live execution)');
        expect(btn.textContent).toContain('Pinned');
    });

    it('translates the UNPINNED half — label and title alike', async () => {
        transOverride.current = NL;
        await mount(gmailStep());
        await openMenu();
        const btn = screen.getByTitle('Zet deze uitvoer vast');
        expect(btn.textContent).toContain('Vastzetten');
        expect(screen.queryByText('Pin')).toBeNull();
    });

    it('translates the PINNED half — the other side of the same two ternaries', async () => {
        transOverride.current = NL;
        await mount(pinned());
        await openMenu();
        const btn = screen.getByTitle('Uitvoer losmaken');
        expect(btn.textContent).toContain('Vastgezet');
        expect(screen.queryByText('Pinned')).toBeNull();
    });
});

describe('NodeDetailView i18n — Edit / Edited', () => {
    it('reads Edit in English while nothing was typed by hand', async () => {
        await mount(gmailStep());
        expect(screen.getByTestId('ndv-edit-output').textContent.trim()).toBe('Edit');
    });

    it('reads Edited in English once the output was typed by hand', async () => {
        await mount(edited());
        expect(screen.getByTestId('ndv-edit-output').textContent.trim()).toBe('Edited');
    });

    it('translates the Edit half', async () => {
        transOverride.current = NL;
        await mount(gmailStep());
        expect(screen.getByTestId('ndv-edit-output').textContent.trim()).toBe('Bewerken');
    });

    it('translates the Edited half', async () => {
        transOverride.current = NL;
        await mount(edited());
        expect(screen.getByTestId('ndv-edit-output').textContent.trim()).toBe('Bewerkt');
    });
});

describe('NodeDetailView i18n — Disable / Re-enable', () => {
    it('offers Disable with the long English title on a live node', async () => {
        await mount(gmailStep());
        await openMenu();
        const btn = screen.getByTitle('Disable this node (skipped during execution)');
        expect(btn.textContent).toContain('Disable');
    });

    it('offers Re-enable with the English title on a disabled node', async () => {
        await mount(gmailStep({ disabled: true }));
        await openMenu();
        const btn = screen.getByTitle('Re-enable this node');
        expect(btn.textContent).toContain('Disabled');
    });

    it('translates the live half — label and title alike', async () => {
        transOverride.current = NL;
        await mount(gmailStep());
        await openMenu();
        const btn = screen.getByTitle('Schakel deze node uit');
        expect(btn.textContent).toContain('Uitschakelen');
        expect(screen.queryByText('Disable')).toBeNull();
    });

    it('translates the disabled half', async () => {
        transOverride.current = NL;
        await mount(gmailStep({ disabled: true }));
        await openMenu();
        const btn = screen.getByTitle('Schakel deze node weer in');
        expect(btn.textContent).toContain('Uitgeschakeld');
        expect(screen.queryByText('Disabled')).toBeNull();
    });
});

describe('NodeDetailView i18n — the Incoming / Continues-on column toggles', () => {
    // Both columns start open, so the first render shows the "Hide" half and
    // one click on each shows the "Show" half.
    it('names both halves in English, on title and aria-label alike', async () => {
        await mount(gmailStep());
        const incoming = screen.getByRole('button', { name: 'Hide input' });
        const continues = screen.getByRole('button', { name: 'Hide output' });
        expect(incoming.getAttribute('title')).toBe('Hide input');
        expect(continues.getAttribute('title')).toBe('Hide output');
        fireEvent.click(incoming);
        fireEvent.click(continues);
        expect(screen.getByRole('button', { name: 'Show input' }).getAttribute('title')).toBe('Show input');
        expect(screen.getByRole('button', { name: 'Show output' }).getAttribute('title')).toBe('Show output');
    });

    it('translates all four halves', async () => {
        transOverride.current = NL;
        await mount(gmailStep());
        const incoming = screen.getByRole('button', { name: 'Invoer verbergen' });
        const continues = screen.getByRole('button', { name: 'Uitvoer verbergen' });
        expect(incoming.getAttribute('title')).toBe('Invoer verbergen');
        expect(continues.getAttribute('title')).toBe('Uitvoer verbergen');
        fireEvent.click(incoming);
        fireEvent.click(continues);
        expect(screen.getByRole('button', { name: 'Invoer tonen' }).getAttribute('title')).toBe('Invoer tonen');
        expect(screen.getByRole('button', { name: 'Uitvoer tonen' }).getAttribute('title')).toBe('Uitvoer tonen');
        expect(screen.queryByRole('button', { name: 'Hide input' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Hide output' })).toBeNull();
    });
});

describe('NodeDetailView i18n — the quick dialog output strip', () => {
    // Three-way, not two: Pin / Pinned / Clear. The header's Pin button is not
    // rendered at quick density, so this strip's button is the only one here.
    const quick = { density: 'quick' };

    it('reads Pin, Pinned and Clear in English across all three states', async () => {
        await mount(gmailStep(), quick);
        expect(screen.getByTitle('Pin this output (skip live execution; reuse the latest output)').textContent.trim()).toBe('Pin');
        cleanup();
        await mount(pinned(), quick);
        expect(screen.getByTitle('Unpin output (re-enable live execution)').textContent.trim()).toBe('Pinned');
        cleanup();
        await mount(edited(), quick);
        expect(screen.getByTitle('Unpin output (re-enable live execution)').textContent.trim()).toBe('Clear');
    });

    it('translates the Pin state', async () => {
        transOverride.current = NL;
        await mount(gmailStep(), quick);
        expect(screen.getByTitle('Zet deze uitvoer vast').textContent.trim()).toBe('Vastzetten');
    });

    it('translates the Pinned state', async () => {
        transOverride.current = NL;
        await mount(pinned(), quick);
        expect(screen.getByTitle('Uitvoer losmaken').textContent.trim()).toBe('Vastgezet');
    });

    it('translates the Clear state — the third branch, reachable only when the output was edited', async () => {
        transOverride.current = NL;
        await mount(edited(), quick);
        expect(screen.getByTitle('Uitvoer losmaken').textContent.trim()).toBe('Wissen');
    });
});
