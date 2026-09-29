/**
 * BulletsCard — "Doet wel" en "Doet niet" (A3 deel A).
 *
 * De zwaarste bewering op dit scherm staat onder "Doet niet": wat daar staat is
 * een INSTRUCTIE, geen blokkade. Die regel moet er staan, en hij moet naar het
 * mechanisme wijzen dat wél hard is.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/role/BulletsCard.test.jsx
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import BulletsCard from './BulletsCard';
import { PERSONA_LIMITS } from './personaFacts';

const t = (key, fallback, params) => {
    let s = typeof fallback === 'string' ? fallback : key;
    for (const [k, v] of Object.entries(params || {})) s = s.split(`{${k}}`).join(String(v));
    return s;
};

afterEach(() => cleanup());

describe('BulletsCard — "Doet niet" is een belofte die niemand afdwingt', () => {
    it('zegt op het scherm dat de regels het model sturen en niets blokkeren', () => {
        render(<BulletsCard t={t} variant="doesNot" items={['Promise a discount']} readOnly />);
        const note = screen.getByTestId('agent-role-does-not-note');
        expect(note.textContent).toMatch(/nothing here blocks the action/i);
    });

    it('wijst naar wat wél hard is: de app, tabel of routine weghalen of laten bevestigen', () => {
        render(<BulletsCard t={t} variant="doesNot" items={['Promise a discount']} readOnly />);
        const note = screen.getByTestId('agent-role-does-not-note').textContent;
        expect(note).toMatch(/Can use/);
        expect(note).toMatch(/ask first/i);
    });

    it('zegt bij "Doet wel" dat een regel geen toegang uitdeelt', () => {
        render(<BulletsCard t={t} variant="does" items={['Start a new quote']} readOnly />);
        expect(screen.getByTestId('agent-role-does-note').textContent)
            .toMatch(/does not hand it the app, table or routine/i);
        expect(screen.queryByTestId('agent-role-does-not-note')).toBeNull();
    });

    it('houdt de regel weg bij een lege alleen-lezen kaart — daar valt niets te beloven', () => {
        render(<BulletsCard t={t} variant="doesNot" items={[]} readOnly />);
        expect(screen.queryByTestId('agent-role-does-not-note')).toBeNull();
        expect(screen.getByTestId('agent-role-does-not-empty')).toBeTruthy();
    });
});

describe('BulletsCard — de lijst', () => {
    it('tekent elke regel', () => {
        render(<BulletsCard t={t} variant="does" items={['One', 'Two']} readOnly />);
        expect(screen.getAllByTestId('agent-role-bullet')).toHaveLength(2);
    });

    it('zegt "niets" alleen als de lijst echt leeg is', () => {
        const { rerender } = render(<BulletsCard t={t} variant="does" items={[]} readOnly />);
        expect(screen.getByTestId('agent-role-does-empty')).toBeTruthy();
        rerender(<BulletsCard t={t} variant="does" items={['One']} readOnly />);
        expect(screen.queryByTestId('agent-role-does-empty')).toBeNull();
    });

    it('biedt geen bewerkknoppen aan in alleen-lezen', () => {
        render(<BulletsCard t={t} variant="does" items={['One']} readOnly />);
        expect(screen.queryByTestId('agent-role-bullet-add')).toBeNull();
        expect(screen.queryByTestId('agent-role-bullet-remove')).toBeNull();
        expect(screen.queryByTestId('agent-role-bullet-text')).toBeNull();
    });
});

describe('BulletsCard — toevoegen, bewerken, verwijderen', () => {
    it('geeft een nieuwe regel door aan de ouder', () => {
        const onAdd = vi.fn(() => null);
        render(<BulletsCard t={t} variant="does" items={[]} onAdd={onAdd} />);
        fireEvent.click(screen.getByTestId('agent-role-bullet-add'));
        const input = screen.getByTestId('agent-role-bullet-add-input');
        fireEvent.change(input, { target: { value: 'Look up quotes' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onAdd).toHaveBeenCalledWith('Look up quotes');
        expect(screen.getByTestId('agent-role-bullet-add')).toBeTruthy();
    });

    it('vertelt waarom een dubbele regel niet verschijnt, in plaats van hem te laten verdampen', () => {
        render(<BulletsCard t={t} variant="does" items={['One']} onAdd={() => 'duplicate'} />);
        fireEvent.click(screen.getByTestId('agent-role-bullet-add'));
        const input = screen.getByTestId('agent-role-bullet-add-input');
        fireEvent.change(input, { target: { value: 'one' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(screen.getByTestId('agent-role-bullet-rejected').textContent).toMatch(/already in this list/i);
        // Het veld blijft open met de tekst erin: er is niets opgeslagen.
        expect(screen.getByTestId('agent-role-bullet-add-input').value).toBe('one');
    });

    it('vertelt dat twintig het maximum is', () => {
        render(<BulletsCard t={t} variant="does" items={[]} onAdd={() => 'full'} />);
        fireEvent.click(screen.getByTestId('agent-role-bullet-add'));
        const input = screen.getByTestId('agent-role-bullet-add-input');
        fireEvent.change(input, { target: { value: 'x' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(screen.getByTestId('agent-role-bullet-rejected').textContent).toMatch(/Twenty lines is the maximum/i);
    });

    it('laat Escape de invoer afbreken zonder de ouder te storen', () => {
        const onAdd = vi.fn(() => null);
        render(<BulletsCard t={t} variant="does" items={[]} onAdd={onAdd} />);
        fireEvent.click(screen.getByTestId('agent-role-bullet-add'));
        const input = screen.getByTestId('agent-role-bullet-add-input');
        fireEvent.change(input, { target: { value: 'oops' } });
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(onAdd).not.toHaveBeenCalled();
        expect(screen.getByTestId('agent-role-bullet-add')).toBeTruthy();
    });

    it('bewerkt een bestaande regel op index', () => {
        const onEdit = vi.fn();
        render(<BulletsCard t={t} variant="does" items={['One', 'Two']} onEdit={onEdit} />);
        fireEvent.click(screen.getAllByTestId('agent-role-bullet-text')[1]);
        const input = screen.getByTestId('agent-role-bullet-input');
        fireEvent.change(input, { target: { value: 'Two and a half' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onEdit).toHaveBeenCalledWith(1, 'Two and a half');
    });

    it('verwijdert op index', () => {
        const onRemove = vi.fn();
        render(<BulletsCard t={t} variant="does" items={['One', 'Two']} onRemove={onRemove} />);
        fireEvent.click(screen.getAllByTestId('agent-role-bullet-remove')[0]);
        expect(onRemove).toHaveBeenCalledWith(0);
    });

    it('zegt het als een BEWERKING geweigerd wordt, en houdt het veld open', () => {
        // Een regel bewerken naar iets dat al in de lijst staat liet er twee in
        // gaan en één uit komen. `editBullet` geeft daar `'duplicate'` op terug;
        // hier komt die reden op het scherm in plaats van een lege plek.
        const onEdit = vi.fn(() => 'duplicate');
        render(<BulletsCard t={t} variant="does" items={['One', 'Two']} onEdit={onEdit} />);
        fireEvent.click(screen.getAllByTestId('agent-role-bullet-text')[1]);
        const input = screen.getByTestId('agent-role-bullet-input');
        fireEvent.change(input, { target: { value: 'one' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(screen.getByTestId('agent-role-bullet-edit-rejected').textContent)
            .toBe('That line is already in this list.');
        expect(screen.getByTestId('agent-role-bullet-input')).toBeTruthy();
    });

    it('beide invoervelden staan op de grens van de server', () => {
        // Zonder `maxLength` knipt `_list` in personaPrompt.js een regel van 400
        // tekens stil af op 300 — de afkapping die deze kaart moet voorkomen.
        render(<BulletsCard t={t} variant="does" items={['One']} onAdd={() => null} onEdit={() => null} />);
        fireEvent.click(screen.getByTestId('agent-role-bullet-add'));
        expect(screen.getByTestId('agent-role-bullet-add-input').maxLength).toBe(PERSONA_LIMITS.bullet);
        fireEvent.click(screen.getAllByTestId('agent-role-bullet-text')[0]);
        expect(screen.getByTestId('agent-role-bullet-input').maxLength).toBe(PERSONA_LIMITS.bullet);
    });
});
