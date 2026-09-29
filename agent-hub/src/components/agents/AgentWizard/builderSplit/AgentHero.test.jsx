/**
 * De hero van de agent-editor (A2 stap 1).
 *
 * Drie beloftes staan hier vast:
 *   - de OMSCHRIJVING staat er altijd, niet achter een "Add description";
 *   - de tierchip leest zijn label uit TIER_META, door t() heen;
 *   - de taalchip komt uit `persona.language` en verschijnt ALLEEN voor een
 *     code die we kunnen benoemen — een rauwe code is geen taal.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/builderSplit/AgentHero.test.jsx
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: false, json: async () => ({}), text: async () => '' })),
}));

import AgentHero, { languageChipLabel } from './AgentHero';
import { READ } from '../canUse/canUseFacts';

// Zelfde resolutie-volgorde als useTranslation: string-fallback wint van de
// sleutel, en {count} wordt ingevuld — anders zou de teller-test een
// letterlijke "{count}/300" goedkeuren.
const t = (key, fallbackOrParams, paramsArg) => {
    const hasFallback = typeof fallbackOrParams === 'string';
    const params = hasFallback ? paramsArg : fallbackOrParams;
    let value = hasFallback ? fallbackOrParams : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) value = value.replaceAll(`{${k}}`, String(v));
    }
    return value;
};

const baseProps = {
    t,
    avatar: '🐝',
    updateAvatar: () => {},
    name: 'Test Agent',
    updateName: () => {},
    flushNow: () => {},
    description: '',
    updateDescription: () => {},
    tiers: {},
    selectedTier: 'fast',
};

afterEach(() => cleanup());

describe('AgentHero — de omschrijving staat er altijd', () => {
    it('toont het omschrijvingsveld ook als de agent er geen heeft', () => {
        render(<AgentHero {...baseProps} description="" />);
        const box = screen.getByTestId('agent-hero-description');
        // Bestaan is niet genoeg: een `hidden` of `display:none` veld is net zo
        // verborgen als een uitklapknop. Zichtbaarheid is de belofte.
        expect(box).toBeVisible();
        expect(box.value).toBe('');
        // Geen "voeg een omschrijving toe"-knop meer die het veld verbergt.
        expect(screen.queryByText(/Add description/i)).toBeNull();
    });

    it('geeft elke toetsaanslag door en klemt op 300 tekens', () => {
        const seen = [];
        render(<AgentHero {...baseProps} updateDescription={(v) => seen.push(v)} />);
        fireEvent.change(screen.getByTestId('agent-hero-description'), { target: { value: 'x'.repeat(340) } });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toHaveLength(300);
    });
});

describe('AgentHero — de chips', () => {
    it('leest het tierlabel uit TIER_META', () => {
        render(<AgentHero {...baseProps} selectedTier="thinking" />);
        expect(screen.getByTestId('agent-hero-tier').textContent).toContain('Think');
    });

    it('toont een custom tier onder de naam die de beheerder zelf gaf', () => {
        render(<AgentHero {...baseProps} selectedTier="custom:legal" tiers={{ 'custom:legal': { label: 'Legal' } }} />);
        expect(screen.getByTestId('agent-hero-tier').textContent).toContain('Legal');
    });

    it('toont geen tierchip voor een tier die niemand kent', () => {
        render(<AgentHero {...baseProps} selectedTier="wat-dan-ook" />);
        expect(screen.queryByTestId('agent-hero-tier')).toBeNull();
    });

    it('benoemt de taal uit de persona', () => {
        render(<AgentHero {...baseProps} language="nl" />);
        expect(screen.getByTestId('agent-hero-language').textContent).toContain('Dutch');
    });

    it('zwijgt over een taal zonder persona en over een code die niets benoemt', () => {
        const { rerender } = render(<AgentHero {...baseProps} language={null} />);
        expect(screen.queryByTestId('agent-hero-language')).toBeNull();
        rerender(<AgentHero {...baseProps} language="zzz" />);
        expect(screen.queryByTestId('agent-hero-language')).toBeNull();
    });
});

// ── A3 deel B: de identiteitsrij ────────────────────────────────────
describe('AgentHero — de identiteitsrij', () => {
    const cats = [{ id: 'c-sales', name: 'Sales' }, { id: 'c-hr', name: 'HR' }];

    it('zet een pencil-badge op het avatar die zelf geen klikken vangt', () => {
        render(<AgentHero {...baseProps} />);
        const badge = screen.getByTestId('agent-hero-avatar-badge');
        expect(badge).toBeVisible();
        // De tegel eronder moet het trefvlak blijven; een badge die klikken
        // opvangt maakt de rand van het avatar dood.
        expect(badge.className).toContain('pointer-events-none');
    });

    it('tekent GEEN pencil-badge bij alleen-lezen — een potlood is een belofte', () => {
        render(<AgentHero {...baseProps} ro />);
        expect(screen.queryByTestId('agent-hero-avatar-badge')).toBeNull();
    });

    it('toont de categorie als tag naast de naam en geeft een keuze door', () => {
        const picked = [];
        render(<AgentHero {...baseProps} categories={cats} categoryId="c-sales" updateCategory={(v) => picked.push(v)} />);
        const select = screen.getByTestId('agent-category-select');
        expect(select.value).toBe('c-sales');
        expect(screen.getByRole('option', { name: 'Sales' })).toBeTruthy();
        fireEvent.change(select, { target: { value: 'c-hr' } });
        expect(picked).toEqual(['c-hr']);
    });

    it('zwijgt over de categorie zolang de lijst nog GELEZEN wordt', () => {
        // Tijdens de bootstrap is `categories` leeg en de toestand LOADING. Een
        // keuzelijst met alleen "No category" zou dan beweren dat deze agent er
        // geen heeft.
        render(<AgentHero {...baseProps} categories={[]} categoryId="c-sales" categoriesState={READ.LOADING} updateCategory={() => {}} />);
        expect(screen.queryByTestId('agent-category-select')).toBeNull();
        expect(screen.queryByTestId('agent-hero-category-unreadable')).toBeNull();
    });

    it('zegt het als de lijst NIET GELEZEN kon worden en de agent er een draagt', () => {
        // Een 403 of netwerkfout landde ook op `[]`, en dan verdween de tag van
        // een agent die er wél een heeft — zonder melding, en sinds A3 is dit de
        // enige plek in de editor waar de categorie te zien is.
        render(<AgentHero {...baseProps} categories={[]} categoryId="c-sales" categoriesState={READ.ERROR} updateCategory={() => {}} />);
        expect(screen.queryByTestId('agent-category-select')).toBeNull();
        expect(screen.getByTestId('agent-hero-category-unreadable').textContent).toMatch(/Category unavailable/i);
    });

    it('biedt bij een mislukte lezing GEEN kiezer aan een agent zonder categorie', () => {
        // Anders staat er een gezaghebbend ogende lijst met alleen "No
        // category", is "+" de enige actie, en maakt de eigenaar een duplicaat
        // van een categorie die gewoon bestaat.
        render(<AgentHero {...baseProps} categories={[]} categoryId={null} categoriesState={READ.ERROR} updateCategory={() => {}} />);
        expect(screen.queryByTestId('agent-category-select')).toBeNull();
        expect(screen.queryByTestId('agent-hero-category-unreadable')).toBeNull();
    });

    it('…en toont hem wél als de lijst gelezen is en leeg blijkt', () => {
        render(<AgentHero {...baseProps} categories={[]} categoryId={null} categoriesState={READ.OK} updateCategory={() => {}} />);
        expect(screen.getByTestId('agent-category-select')).toBeVisible();
    });

    it('toont geen categorietag zonder een handler die hem kan opslaan', () => {
        render(<AgentHero {...baseProps} categories={cats} categoryId="c-sales" />);
        expect(screen.queryByTestId('agent-category-select')).toBeNull();
    });

    it('zegt onder de teller waar de omschrijving terechtkomt', () => {
        render(<AgentHero {...baseProps} description={'x'.repeat(164)} />);
        const counter = screen.getByTestId('agent-hero-description-counter');
        expect(counter.textContent).toBe('164/300 · Shown in the agent picker');
    });

    it('telt de LEGE omschrijving ook — 0/300, geen lege teller', () => {
        render(<AgentHero {...baseProps} description="" />);
        expect(screen.getByTestId('agent-hero-description-counter').textContent).toMatch(/^0\/300 · /);
    });
});

describe('languageChipLabel', () => {
    it('benoemt wat het kan en weigert de rest', () => {
        expect(languageChipLabel('nl')).toBe('Dutch');
        expect(languageChipLabel('NL-be')).toBe('Dutch');
        expect(languageChipLabel('')).toBeNull();
        expect(languageChipLabel(null)).toBeNull();
        expect(languageChipLabel(42)).toBeNull();
        expect(languageChipLabel('nederlands')).toBeNull();
    });
});
