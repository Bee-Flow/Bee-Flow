/**
 * The hero of the agent editor (A2 step 1).
 *
 * Three promises are fixed here:
 *   - the DESCRIPTION is always there, not behind an "Add description";
 *   - the tier chip reads its label from TIER_META, through t();
 *   - the language chip comes from `persona.language` and appears ONLY for a
 *     code we can name. A raw code is not a language.
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
import type { TranslateParams } from '@/hooks/useTranslation';
import { omitted } from '@/test/mocks';
import type { ComponentProps } from 'react';

// Same resolution order as useTranslation: the string fallback wins over the
// key, and {count} is filled in. Otherwise the counter test would approve a
// literal "{count}/300".
const t = (key: string, fallbackOrParams?: string | TranslateParams, paramsArg?: TranslateParams | null) => {
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
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} description="" />);
        const box = screen.getByTestId('agent-hero-description');
        // Existence is not enough: a `hidden` or `display:none` field is just as
        // hidden as an expand button. Visibility is the promise.
        expect(box).toBeVisible();
        expect((box as HTMLInputElement).value).toBe('');
        // No more "add a description" button that hides the field.
        expect(screen.queryByText(/Add description/i)).toBeNull();
    });

    it('geeft elke toetsaanslag door en klemt op 300 tekens', () => {
        const seen: unknown[] = [];
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} updateDescription={(v) => seen.push(v)} />);
        fireEvent.change(screen.getByTestId('agent-hero-description'), { target: { value: 'x'.repeat(340) } });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toHaveLength(300);
    });
});

describe('AgentHero — de chips', () => {
    it('leest het tierlabel uit TIER_META', () => {
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} selectedTier="thinking" />);
        expect(screen.getByTestId('agent-hero-tier').textContent).toContain('Think');
    });

    it('toont een custom tier onder de naam die de beheerder zelf gaf', () => {
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} selectedTier="custom:legal" tiers={{ 'custom:legal': { label: 'Legal' } }} />);
        expect(screen.getByTestId('agent-hero-tier').textContent).toContain('Legal');
    });

    it('toont geen tierchip voor een tier die niemand kent', () => {
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} selectedTier="wat-dan-ook" />);
        expect(screen.queryByTestId('agent-hero-tier')).toBeNull();
    });

    it('benoemt de taal uit de persona', () => {
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} language="nl" />);
        expect(screen.getByTestId('agent-hero-language').textContent).toContain('Dutch');
    });

    it('zwijgt over een taal zonder persona en over een code die niets benoemt', () => {
        const { rerender } = render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} language={null} />);
        expect(screen.queryByTestId('agent-hero-language')).toBeNull();
        rerender(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} language="zzz" />);
        expect(screen.queryByTestId('agent-hero-language')).toBeNull();
    });
});

// ── A3 deel B: de identiteitsrij ────────────────────────────────────
describe('AgentHero — de identiteitsrij', () => {
    const cats = [{ id: 'c-sales', name: 'Sales' }, { id: 'c-hr', name: 'HR' }];

    it('zet een pencil-badge op het avatar die zelf geen klikken vangt', () => {
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} />);
        const badge = screen.getByTestId('agent-hero-avatar-badge');
        expect(badge).toBeVisible();
        // The tile below must remain the hit area. A badge that catches clicks
        // would kill the edge of the avatar.
        expect(badge.className).toContain('pointer-events-none');
    });

    it('tekent GEEN pencil-badge bij alleen-lezen — een potlood is een belofte', () => {
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} ro />);
        expect(screen.queryByTestId('agent-hero-avatar-badge')).toBeNull();
    });

    it('toont de categorie als tag naast de naam en geeft een keuze door', () => {
        const picked: unknown[] = [];
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} categories={cats} categoryId="c-sales" updateCategory={(v) => picked.push(v)} />);
        const select = screen.getByTestId('agent-category-select');
        expect((select as HTMLInputElement).value).toBe('c-sales');
        expect(screen.getByRole('option', { name: 'Sales' })).toBeTruthy();
        fireEvent.change(select, { target: { value: 'c-hr' } });
        expect(picked).toEqual(['c-hr']);
    });

    it('zwijgt over de categorie zolang de lijst nog GELEZEN wordt', () => {
        // During bootstrap `categories` is empty and the state is LOADING. A
        // dropdown with only "No category" would then claim that this agent has none.
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} categories={[]} categoryId="c-sales" categoriesState={READ.LOADING} updateCategory={() => {}} />);
        expect(screen.queryByTestId('agent-category-select')).toBeNull();
        expect(screen.queryByTestId('agent-hero-category-unreadable')).toBeNull();
    });

    it('zegt het als de lijst NIET GELEZEN kon worden en de agent er een draagt', () => {
        // A 403 or a network error also landed on `[]`, and then the tag of an agent
        // that DID have one disappeared, without a message. Since A3 this is the
        // only place in the editor where the category is visible.
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} categories={[]} categoryId="c-sales" categoriesState={READ.ERROR} updateCategory={() => {}} />);
        expect(screen.queryByTestId('agent-category-select')).toBeNull();
        expect(screen.getByTestId('agent-hero-category-unreadable').textContent).toMatch(/Category unavailable/i);
    });

    it('biedt bij een mislukte lezing GEEN kiezer aan een agent zonder categorie', () => {
        // Otherwise there would be an authoritative-looking list with only "No
        // category", "+" would be the only action, and the owner would create a
        // duplicate of a category that does exist.
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} categories={[]} categoryId={null} categoriesState={READ.ERROR} updateCategory={() => {}} />);
        expect(screen.queryByTestId('agent-category-select')).toBeNull();
        expect(screen.queryByTestId('agent-hero-category-unreadable')).toBeNull();
    });

    it('…en toont hem wél als de lijst gelezen is en leeg blijkt', () => {
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} categories={[]} categoryId={null} categoriesState={READ.OK} updateCategory={() => {}} />);
        expect(screen.getByTestId('agent-category-select')).toBeVisible();
    });

    it('toont geen categorietag zonder een handler die hem kan opslaan', () => {
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} categories={cats} categoryId="c-sales" />);
        expect(screen.queryByTestId('agent-category-select')).toBeNull();
    });

    it('zegt onder de teller waar de omschrijving terechtkomt', () => {
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} description={'x'.repeat(164)} />);
        const counter = screen.getByTestId('agent-hero-description-counter');
        expect(counter.textContent).toBe('164/300 · Shown in the agent picker');
    });

    it('telt de LEGE omschrijving ook — 0/300, geen lege teller', () => {
        render(<AgentHero {...omitted<ComponentProps<typeof AgentHero>>()} {...baseProps} description="" />);
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
