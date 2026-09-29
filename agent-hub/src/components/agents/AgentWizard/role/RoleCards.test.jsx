/**
 * RoleCards — de vijf kaarten van de tab "Rol" samen (A3 deel A).
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/role/RoleCards.test.jsx
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { PERSONA_LIMITS, READ } from './personaFacts';
import RoleCards from './RoleCards';

const t = (key, fallback, params) => {
    let s = typeof fallback === 'string' ? fallback : key;
    for (const [k, v] of Object.entries(params || {})) s = s.split(`{${k}}`).join(String(v));
    return s;
};

const PERSONA = {
    who: 'An experienced colleague.',
    tone: { chips: ['formal'], text: 'Answer first.' },
    does: ['Look up quotes'],
    doesNot: ['Promise a discount'],
    unknown: { mode: 'honest', automationId: null },
    language: null,
    mode: 'fields',
    freeText: '',
};

const base = { t, persona: PERSONA, agentOwnerId: 'u1', userId: 'u1' };

afterEach(() => cleanup());

describe('RoleCards — vijf kaarten', () => {
    it('tekent ze alle vijf', () => {
        render(<RoleCards {...base} />);
        for (const id of ['agent-role-who', 'agent-role-tone', 'agent-role-does', 'agent-role-does-not', 'agent-role-unknown']) {
            expect(screen.getByTestId(id), id).toBeTruthy();
        }
    });

    it('zet het "Wie is het"-veld op de grens van de server', () => {
        render(<RoleCards {...base} />);
        const input = screen.getByTestId('agent-role-who-input');
        expect(input.value).toBe('An experienced colleague.');
        expect(input.maxLength).toBe(PERSONA_LIMITS.who);
    });
});

describe('RoleCards — onbekend is geen lege rol', () => {
    it('tekent geen kaarten zolang de persona nog gelezen wordt', () => {
        render(<RoleCards {...base} persona={null} personaState={READ.LOADING} />);
        expect(screen.getByTestId('agent-role-loading')).toBeTruthy();
        expect(screen.queryByTestId('agent-role-who')).toBeNull();
    });

    it('zegt bij een onleesbare persona dat het onbekend is, niet dat er niets is', () => {
        render(<RoleCards {...base} persona={undefined} />);
        const note = screen.getByTestId('agent-role-unreadable-note');
        expect(note.textContent).toMatch(/could not be read/i);
        expect(note.textContent).toMatch(/not the same as the agent having no role/i);
        expect(screen.queryByTestId('agent-role-does')).toBeNull();
    });

    it('tekent een LEGE maar gelezen persona wél als vijf kaarten', () => {
        render(<RoleCards {...base} persona={{}} />);
        expect(screen.getByTestId('agent-role-who')).toBeTruthy();
        expect(screen.queryByTestId('agent-role-unreadable')).toBeNull();
    });

    it('een MISLUKTE conceptlezing geeft de waarschuwing, niet vijf lege kaarten', () => {
        // De hele reden dat `useAgentConceptFacts` een `personaState` heeft: een
        // 403 op `?draft=1`, of een antwoord zonder persona, mag niet als "deze
        // agent heeft geen rol" op het scherm komen.
        render(<RoleCards {...base} persona={null} personaState={READ.ERROR} />);
        expect(screen.getByTestId('agent-role-unreadable-note').textContent)
            .toMatch(/not the same as the agent having no role/i);
        expect(screen.queryByTestId('agent-role-who')).toBeNull();
    });

    it('een persona die we WEL hebben wint van een mislukte tweede lezing', () => {
        // De aanroeper stelt `persona={agent?.persona ?? conceptFacts.persona}`
        // samen; als die eerste helft leesbaar is, is een mislukte `?draft=1`
        // geen reden om een rol te verbergen die we hebben.
        render(<RoleCards {...base} persona={PERSONA} personaState={READ.ERROR} />);
        expect(screen.getByTestId('agent-role-who-input').value).toBe('An experienced colleague.');
        expect(screen.queryByTestId('agent-role-unreadable')).toBeNull();
    });

    it('LOADING telt alleen zolang er nog niets leesbaars is', () => {
        render(<RoleCards {...base} persona={PERSONA} personaState={READ.LOADING} />);
        expect(screen.queryByTestId('agent-role-loading')).toBeNull();
        expect(screen.getByTestId('agent-role-who')).toBeTruthy();
    });
});

describe('RoleCards — schrijven levert altijd een VOLLEDIGE persona', () => {
    it('stuurt elk veld mee bij een wijziging van één veld', () => {
        const onChange = vi.fn();
        render(<RoleCards {...base} onChange={onChange} />);
        fireEvent.change(screen.getByTestId('agent-role-who-input'), { target: { value: 'Someone else.' } });
        const next = onChange.mock.calls[0][0];
        expect(next.who).toBe('Someone else.');
        expect(next.does).toEqual(['Look up quotes']);
        expect(next.doesNot).toEqual(['Promise a discount']);
        expect(next.tone).toEqual({ chips: ['formal'], text: 'Answer first.' });
        expect(next.unknown).toEqual({ mode: 'honest', automationId: null });
    });

    it('voegt een bullet toe en laat de rest staan', () => {
        const onChange = vi.fn();
        render(<RoleCards {...base} onChange={onChange} />);
        const card = screen.getByTestId('agent-role-does-not');
        fireEvent.click(card.querySelector('[data-testid="agent-role-bullet-add"]'));
        const input = card.querySelector('[data-testid="agent-role-bullet-add-input"]');
        fireEvent.change(input, { target: { value: 'Change a price' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onChange.mock.calls[0][0].doesNot).toEqual(['Promise a discount', 'Change a price']);
    });

    it('weigert een dubbele bullet zonder de ouder lastig te vallen', () => {
        const onChange = vi.fn();
        render(<RoleCards {...base} onChange={onChange} />);
        const card = screen.getByTestId('agent-role-does');
        fireEvent.click(card.querySelector('[data-testid="agent-role-bullet-add"]'));
        const input = card.querySelector('[data-testid="agent-role-bullet-add-input"]');
        fireEvent.change(input, { target: { value: 'look up QUOTES' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onChange).not.toHaveBeenCalled();
        expect(card.querySelector('[data-testid="agent-role-bullet-rejected"]')).toBeTruthy();
    });

    it('schakelt een toonchip om via de opgeslagen waarde', () => {
        const onChange = vi.fn();
        render(<RoleCards {...base} onChange={onChange} />);
        fireEvent.click(screen.getByText('Short'));
        expect(onChange.mock.calls[0][0].tone.chips).toEqual(['formal', 'concise']);
    });

    it('laat het gekozen routine-id vallen zodra de modus geen handoff meer is', () => {
        const onChange = vi.fn();
        const handoff = { ...PERSONA, unknown: { mode: 'handoff', automationId: 'a1' } };
        render(<RoleCards {...base} persona={handoff} onChange={onChange} />);
        fireEvent.click(screen.getAllByRole('radio')[1]);
        expect(onChange.mock.calls[0][0].unknown).toEqual({ mode: 'web', automationId: null });
    });
});

describe('RoleCards — de voetregel naar de vrije instructie', () => {
    it('staat er met een handler, en zegt niet dat de vakken synchroon blijven', () => {
        const onOpenFree = vi.fn();
        render(<RoleCards {...base} onOpenFree={onOpenFree} />);
        const footer = screen.getByTestId('agent-role-free-footer');
        expect(footer.textContent).toMatch(/Open as free instruction/);
        expect(footer.textContent).toMatch(/reading them back is a separate step/i);
        expect(footer.textContent).not.toMatch(/in sync/i);
        fireEvent.click(screen.getByTestId('agent-role-free-open'));
        expect(onOpenFree).toHaveBeenCalled();
    });

    it('staat er niet zonder handler — een knop die niets doet is erger dan geen knop', () => {
        render(<RoleCards {...base} />);
        expect(screen.queryByTestId('agent-role-free-footer')).toBeNull();
    });

    it('staat er niet in alleen-lezen', () => {
        render(<RoleCards {...base} readOnly onOpenFree={() => {}} />);
        expect(screen.queryByTestId('agent-role-free-footer')).toBeNull();
    });
});

describe('RoleCards — vrije modus', () => {
    const free = { ...PERSONA, mode: 'free', freeText: 'You are a helpful assistant.' };

    it('zegt dat de vrije tekst de bron is en zet de kaarten op alleen-lezen', () => {
        render(<RoleCards {...base} persona={free} />);
        expect(screen.getByTestId('agent-role-free-banner').textContent).toMatch(/that text is what it runs/i);
        expect(screen.queryByTestId('agent-role-who-input')).toBeNull();
        expect(screen.getByTestId('agent-role-who-text').textContent).toBe('An experienced colleague.');
        expect(screen.queryByTestId('agent-role-bullet-add')).toBeNull();
    });

    it('biedt de terugweg alleen aan als de ouder hem kan uitvoeren', () => {
        const { rerender } = render(<RoleCards {...base} persona={free} />);
        expect(screen.queryByTestId('agent-role-back-to-fields')).toBeNull();
        const onBackToFields = vi.fn();
        rerender(<RoleCards {...base} persona={free} onBackToFields={onBackToFields} />);
        fireEvent.click(screen.getByTestId('agent-role-back-to-fields'));
        expect(onBackToFields).toHaveBeenCalled();
    });

    it('biedt geen voetregel naar de vrije modus als hij er al in staat', () => {
        render(<RoleCards {...base} persona={free} onOpenFree={() => {}} />);
        expect(screen.queryByTestId('agent-role-free-footer')).toBeNull();
    });

    it('belooft NIET dat de velden hem beschrijven als er niets in staat', () => {
        // Het meerderheidsgeval, niet de rand: elke agent van vóór A1c leest via
        // `personaOf` terug als `{mode:'free', freeText: system_prompt}` met alle
        // velden leeg. De oude banner zei "The fields below describe it" boven
        // vijf kaarten die "Nothing written down yet." zeggen, over een agent
        // die aantoonbaar een rol, een toon en regels heeft.
        const underived = {
            who: '', tone: { chips: [], text: '' }, does: [], doesNot: [],
            unknown: { mode: 'honest', automationId: null }, language: null,
            mode: 'free', freeText: 'You are a helpful assistant that books meetings.',
        };
        render(<RoleCards {...base} persona={underived} />);
        const banner = screen.getByTestId('agent-role-free-banner');
        expect(banner.getAttribute('data-describes')).toBe('no');
        expect(banner.textContent).toMatch(/Nothing has been read back out of it yet/i);
        expect(banner.textContent).not.toMatch(/The fields below describe it/i);
    });

    it('zegt het wél als de velden echt gevuld zijn', () => {
        render(<RoleCards {...base} persona={free} />);
        const banner = screen.getByTestId('agent-role-free-banner');
        expect(banner.getAttribute('data-describes')).toBe('yes');
        expect(banner.textContent).toMatch(/The fields below describe it/i);
    });
});

describe('RoleCards — alleen-lezen', () => {
    it('biedt nergens een bewerkveld', () => {
        render(<RoleCards {...base} readOnly />);
        expect(screen.queryByTestId('agent-role-who-input')).toBeNull();
        expect(screen.queryByTestId('agent-role-tone-input')).toBeNull();
        expect(screen.queryByTestId('agent-role-bullet-add')).toBeNull();
        expect(screen.getAllByRole('radio').every(r => r.disabled)).toBe(true);
    });
});
