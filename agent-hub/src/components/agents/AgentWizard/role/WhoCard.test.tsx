/**
 * WhoCard — "Wie is het" (A3 deel A).
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/role/WhoCard.test.jsx
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { PERSONA_LIMITS } from './personaFacts';
import WhoCard from './WhoCard';
import userEvent from '@testing-library/user-event';

const t = (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key);

afterEach(() => cleanup());

describe('WhoCard', () => {
    it('geeft elke aanslag door en houdt getypte spaties heel', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<WhoCard t={t} value="" onChange={onChange} />);
        await user.clear(screen.getByTestId('agent-role-who-input'));
        await user.type(screen.getByTestId('agent-role-who-input'), 'A colleague ');
        expect(onChange).toHaveBeenCalledWith('A colleague ');
    });

    it('laat de server niet stilletjes knippen: maxLength staat op 600', () => {
        render(<WhoCard t={t} value="" />);
        expect((screen.getByTestId('agent-role-who-input') as HTMLInputElement).maxLength).toBe(PERSONA_LIMITS.who);
    });

    it('houdt de teller weg tot hij ergens over gaat, en kleurt hem op de grens', () => {
        const { rerender } = render(<WhoCard t={t} value="short" />);
        expect(screen.queryByTestId('agent-role-who-counter')).toBeNull();
        rerender(<WhoCard t={t} value={'x'.repeat(PERSONA_LIMITS.who)} />);
        const counter = screen.getByTestId('agent-role-who-counter');
        expect(counter.textContent.replace(/\s/g, '')).toBe(`${PERSONA_LIMITS.who}/${PERSONA_LIMITS.who}`);
    });

    it('toont in alleen-lezen de tekst, en zegt "niets" alleen als er niets staat', () => {
        const { rerender } = render(<WhoCard t={t} value="A colleague." readOnly />);
        expect(screen.getByTestId('agent-role-who-text').textContent).toBe('A colleague.');
        expect(screen.queryByTestId('agent-role-who-input')).toBeNull();
        rerender(<WhoCard t={t} value="" readOnly />);
        expect(screen.getByTestId('agent-role-who-empty').textContent).toBe('Nothing written down yet.');
    });
});
