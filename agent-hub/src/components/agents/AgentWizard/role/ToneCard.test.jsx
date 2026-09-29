/**
 * ToneCard — "Hoe het praat" (A3 deel A).
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/role/ToneCard.test.jsx
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { PERSONA_LIMITS } from './personaFacts';
import ToneCard from './ToneCard';

const t = (key, fallback, params) => {
    let s = typeof fallback === 'string' ? fallback : key;
    for (const [k, v] of Object.entries(params || {})) s = s.split(`{${k}}`).join(String(v));
    return s;
};

const persona = (over = {}) => ({
    who: '', tone: { chips: [], text: '' }, does: [], doesNot: [],
    unknown: { mode: 'honest', automationId: null }, language: null, mode: 'fields', freeText: '',
    ...over,
});

afterEach(() => cleanup());

describe('ToneCard — de vijf chips', () => {
    it('biedt de vijf uit het artboard aan, met Engelse labels', () => {
        render(<ToneCard t={t} persona={persona()} />);
        const labels = screen.getAllByTestId('agent-role-tone-chip').map(b => b.textContent);
        expect(labels).toEqual([
            'Businesslike', 'Friendly', 'Short', 'Amounts in €', 'Dutch, unless asked otherwise',
        ]);
    });

    it('is een MEERVOUDIGE keuze, geen radiogroup — aria-pressed, niet aria-checked', () => {
        render(<ToneCard t={t} persona={persona({ tone: { chips: ['formal', 'concise'], text: '' } })} />);
        const group = screen.getByTestId('agent-role-tone-chips');
        expect(group.getAttribute('role')).toBe('group');
        const chips = screen.getAllByTestId('agent-role-tone-chip');
        expect(chips.map(c => c.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'true', 'false', 'false']);
        expect(chips.some(c => c.hasAttribute('aria-checked'))).toBe(false);
    });

    it('geeft de WAARDE door, niet het label — die waarde gaat in het prompt', () => {
        const onToggleChip = vi.fn();
        render(<ToneCard t={t} persona={persona()} onToggleChip={onToggleChip} />);
        fireEvent.click(screen.getByText('Amounts in €'));
        expect(onToggleChip).toHaveBeenCalledWith('amounts in euros');
    });

    it('toont een chip die de kaart niet aanbiedt woordelijk, in plaats van hem te laten vallen', () => {
        render(<ToneCard t={t} persona={persona({ tone: { chips: ['warm'], text: '' } })} />);
        expect(screen.getAllByTestId('agent-role-tone-chip').map(b => b.textContent)).toContain('warm');
        expect(screen.getByTestId('agent-role-tone-own')).toBeTruthy();
    });

    it('schakelt de uit-staande chips uit als de twaalf vol zijn, en zegt waarom', () => {
        const chips = Array.from({ length: PERSONA_LIMITS.chips }, (_, i) => `own${i}`);
        render(<ToneCard t={t} persona={persona({ tone: { chips, text: '' } })} />);
        const off = screen.getAllByTestId('agent-role-tone-chip').filter(c => c.getAttribute('aria-pressed') === 'false');
        expect(off.length).toBeGreaterThan(0);
        expect(off.every(c => c.disabled)).toBe(true);
        expect(screen.getByTestId('agent-role-tone-full').textContent).toMatch(/Twelve tone words is the maximum/i);
    });
});

describe('ToneCard — de botsing met de harde taalregel', () => {
    it('waarschuwt als er een vaste taal staat én de zachte taalchip aan is', () => {
        render(<ToneCard t={t} persona={persona({ language: 'nl', tone: { chips: ['Dutch unless asked otherwise'], text: '' } })} />);
        expect(screen.getByTestId('agent-role-tone-clash').textContent).toMatch(/overrules/i);
    });

    it('zwijgt zonder vaste taal', () => {
        render(<ToneCard t={t} persona={persona({ tone: { chips: ['Dutch unless asked otherwise'], text: '' } })} />);
        expect(screen.queryByTestId('agent-role-tone-clash')).toBeNull();
    });
});

describe('ToneCard — de vrije toontekst', () => {
    it('geeft elke aanslag door', () => {
        const onChangeText = vi.fn();
        render(<ToneCard t={t} persona={persona()} onChangeText={onChangeText} />);
        fireEvent.change(screen.getByTestId('agent-role-tone-input'), { target: { value: 'Answer first.' } });
        expect(onChangeText).toHaveBeenCalledWith('Answer first.');
    });

    it('laat de server niet stilletjes knippen: maxLength staat op de grens', () => {
        render(<ToneCard t={t} persona={persona()} />);
        expect(screen.getByTestId('agent-role-tone-input').maxLength).toBe(PERSONA_LIMITS.toneText);
    });

    it('toont de teller pas als hij ergens over gaat', () => {
        const { rerender } = render(<ToneCard t={t} persona={persona({ tone: { chips: [], text: 'short' } })} />);
        expect(screen.queryByTestId('agent-role-tone-counter')).toBeNull();
        rerender(<ToneCard t={t} persona={persona({ tone: { chips: [], text: 'x'.repeat(PERSONA_LIMITS.toneText) } })} />);
        expect(screen.getByTestId('agent-role-tone-counter').textContent).toContain(String(PERSONA_LIMITS.toneText));
    });
});

describe('ToneCard — alleen-lezen', () => {
    it('toont alleen wat aan staat en biedt geen knoppen', () => {
        render(<ToneCard t={t} persona={persona({ tone: { chips: ['concise'], text: 'Answer first.' } })} readOnly />);
        const chips = screen.getAllByTestId('agent-role-tone-chip');
        expect(chips).toHaveLength(1);
        expect(chips[0].tagName).toBe('SPAN');
        expect(screen.queryByTestId('agent-role-tone-input')).toBeNull();
        expect(screen.getByTestId('agent-role-tone-text').textContent).toBe('Answer first.');
    });

    it('zegt "geen toon" alleen als er echt niets aan staat', () => {
        render(<ToneCard t={t} persona={persona()} readOnly />);
        expect(screen.getByTestId('agent-role-tone-empty')).toBeTruthy();
    });
});
