import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * "Laatst bewerkt" op het Startscherm. Vier dingen worden hier vastgelegd,
 * omdat het de vier zijn die stilletjes verkeerd gaan:
 *
 *   1. "nog niets bewerkt" en "we konden niet overal kijken" zijn twee zinnen,
 *      en de tweede wordt nooit als de eerste getekend;
 *   2. een soort die geen status meldt krijgt er geen verzonnen — en ook geen
 *      lege plek, want die leest als "in orde";
 *   3. een rij opent het ding zelf, op het pad dat het model uitrekende;
 *   4. vóór het eerste antwoord wordt er niets beweerd.
 *
 * `runRecentWork` is gestubd (hij wordt hiernaast tegen een gestubde
 * authFetch getest); de statuswoorden eromheen zijn de echte.
 */

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock('./recentWork', async (importOriginal) => ({
    ...(await importOriginal()),
    runRecentWork: (...args) => runMock(...args),
}));

vi.mock('../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let value = typeof fallback === 'string' ? fallback : key;
            const p = typeof fallback === 'string' ? params : fallback;
            if (p && typeof p === 'object') {
                for (const [k, v] of Object.entries(p)) value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
            }
            return value;
        },
        locale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

import RecentWorkList from './RecentWorkList.jsx';
import { RECENT_STATUS } from '../../../../utils/studioRecentSources';

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const HOUR_AGO = new Date(Date.now() - 3600 * 1000).toISOString();

const entry = (over = {}) => ({
    key: 'aiTasks:r1',
    id: 'r1',
    sectionId: 'aiTasks',
    kind: 'automation',
    name: 'Offerte-automation',
    description: 'Maakt offertes',
    updatedAt: HOUR_AGO,
    at: Date.parse(HOUR_AGO),
    status: RECENT_STATUS.ACTIVE,
    path: 'studio/automations/r1',
    ...over,
});

const answer = (over = {}) => ({ items: [], unavailable: [], skipped: [], complete: true, ...over });

const SECTIONS = [
    { id: 'aiTasks', urlSegment: 'automations', kind: 'automation', labelKey: 'studio.tab.automations', labelFallback: 'Automations', locked: null },
    { id: 'knowledge', urlSegment: 'knowledge', kind: 'kb', labelKey: 'studio.tab.knowledge', labelFallback: 'Knowledge', locked: null },
];

const renderList = (props = {}) => render(
    <RecentWorkList sections={SECTIONS} onNavigate={vi.fn()} {...props} />,
);

describe('RecentWorkList', () => {
    beforeEach(() => {
        cleanup();
        runMock.mockReset();
        runMock.mockResolvedValue(answer());
    });

    it('belooft niets vóór het eerste antwoord', () => {
        // Een lege lijst of een geruststelling boven een lopende fetch is een
        // bewering die dit scherm nog niet kan onderbouwen.
        runMock.mockReturnValue(new Promise(() => {}));
        renderList();
        expect(screen.queryByTestId('studio-recent')).toBeNull();
    });

    it('tekent de rijen, met soort, statuswoord en tijd, en opent er een', async () => {
        const onNavigate = vi.fn();
        runMock.mockResolvedValue(answer({ items: [entry()] }));
        renderList({ onNavigate });

        const row = await screen.findByTestId('studio-recent-item-aiTasks:r1');
        expect(row.getAttribute('data-kind')).toBe('automation');
        expect(row.textContent).toContain('Offerte-automation');
        expect(row.textContent).toContain('Maakt offertes');
        expect(screen.getByTestId('studio-recent-status-aiTasks:r1').textContent).toBe('On');
        expect(screen.getByTestId('studio-recent-when-aiTasks:r1').textContent).toBe('1h ago');

        fireEvent.click(row);
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/r1');
    });

    it('een rij zonder leesbare tijd toont er geen — "just now" zou verzonnen zijn', async () => {
        runMock.mockResolvedValue(answer({ items: [entry({ updatedAt: null, at: null })] }));
        renderList();
        await screen.findByTestId('studio-recent-item-aiTasks:r1');
        expect(screen.queryByTestId('studio-recent-when-aiTasks:r1')).toBeNull();
    });

    it('leeg én heel: "nog niets bewerkt"', async () => {
        renderList();
        expect((await screen.findByTestId('studio-recent-empty')).textContent).toBe('Nothing edited yet.');
        expect(screen.queryByTestId('studio-recent-empty-unread')).toBeNull();
    });

    it('leeg maar NIET heel: geen schone gezondheidsverklaring, en de lijsten worden genoemd', async () => {
        runMock.mockResolvedValue(answer({ unavailable: ['aiTasks'], complete: false }));
        renderList();
        const line = await screen.findByTestId('studio-recent-empty-unread');
        expect(screen.queryByTestId('studio-recent-empty')).toBeNull();
        // De sectienaam komt uit hetzelfde register als de rail.
        expect(line.textContent).toContain('Automations');
    });

    it('rijen én een gat: de rijen blijven staan, met de waarschuwing erboven', async () => {
        runMock.mockResolvedValue(answer({ items: [entry()], unavailable: ['knowledge'], complete: false }));
        renderList();
        expect(await screen.findByTestId('studio-recent-item-aiTasks:r1')).toBeTruthy();
        expect(screen.getByTestId('studio-recent-partial').textContent)
            .toBe('Could not read this list: Knowledge');
    });

    it('twee lijsten is een ander woord dan één — nooit "list(s)"', async () => {
        runMock.mockResolvedValue(answer({ items: [entry()], unavailable: ['aiTasks', 'knowledge'], complete: false }));
        renderList();
        await screen.findByTestId('studio-recent-item-aiTasks:r1');
        expect(screen.getByTestId('studio-recent-partial').textContent)
            .toBe('Could not read these lists: Automations, Knowledge');
    });

    it('een geweigerde of gelockte sectie zwijgt — dat is geen gat', async () => {
        runMock.mockResolvedValue(answer({ items: [entry()], skipped: ['apps', 'agents'] }));
        renderList();
        await screen.findByTestId('studio-recent-item-aiTasks:r1');
        expect(screen.queryByTestId('studio-recent-partial')).toBeNull();
        expect(screen.queryByTestId('studio-recent-empty-unread')).toBeNull();
    });

    it('een soort zonder status krijgt het woord én de uitleg, geen vinkje en geen leegte', async () => {
        runMock.mockResolvedValue(answer({
            items: [entry({ key: 'knowledge:k1', kind: 'kb', name: 'Handboek', status: RECENT_STATUS.UNSUPPORTED, path: 'studio/knowledge/k1' })],
        }));
        renderList();
        const chip = await screen.findByTestId('studio-recent-status-knowledge:k1');
        expect(chip.textContent).toBe('No status');
        expect(chip.getAttribute('data-status')).toBe('unsupported');
        expect(chip.getAttribute('title')).toBe('This kind does not report a status in this list.');
        // Neutrale inkt: geen groen, geen rood.
        expect(chip.getAttribute('style')).toContain('var(--text-tertiary)');
        expect(screen.getByTestId('studio-recent-statusless')).toBeTruthy();
    });

    it('"status onbekend" is een ander woord dan "geen status", en zet de zin niet aan', async () => {
        runMock.mockResolvedValue(answer({ items: [entry({ status: RECENT_STATUS.UNKNOWN })] }));
        renderList();
        const chip = await screen.findByTestId('studio-recent-status-aiTasks:r1');
        expect(chip.textContent).toBe('Status unknown');
        // De zin onder de lijst gaat over soorten die er geen MELDEN; deze
        // meldt er wel een en had hem alleen niet bij zich.
        expect(screen.queryByTestId('studio-recent-statusless')).toBeNull();
    });

    it('vraagt met de secties en de limiet, en niet nog eens bij dezelfde lijst', async () => {
        runMock.mockResolvedValue(answer({ items: [entry()] }));
        const { rerender } = render(<RecentWorkList sections={SECTIONS} onNavigate={vi.fn()} limit={5} />);
        await screen.findByTestId('studio-recent-item-aiTasks:r1');
        expect(runMock).toHaveBeenCalledTimes(1);
        expect(runMock.mock.calls[0][0]).toEqual(SECTIONS);
        expect(runMock.mock.calls[0][1]).toEqual({ limit: 5, gatesResolved: true });

        // Dezelfde secties, een nieuwe array-identiteit: dat is geen reden om
        // negen lijsten opnieuw op te halen.
        rerender(<RecentWorkList sections={[...SECTIONS]} onNavigate={vi.fn()} limit={5} />);
        await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    });
});
