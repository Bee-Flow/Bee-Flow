/**
 * De "Gedaan: …"-beurt van de verfijn-rail (A2 stap 5).
 *
 * Wat hier vastgepind wordt, is precies wat een volgende stage per ongeluk
 * kan omdraaien:
 *   - een LEGE diff is een ZIN ("er veranderde niets"), geen leeg lijstje;
 *   - de ongedaan-knop VERDWIJNT NOOIT: zonder herstelpunt en op een
 *     ingehaalde beurt staat hij er nog steeds, uitgeschakeld, met de reden;
 *   - een uitgeschakelde knop roept onUndo niet aan — dat is het verschil
 *     tussen "niets doen" en "iets ANDERS herstellen";
 *   - de enkelvoud/meervoud-keuze is een SLEUTELkeuze (nOf), geen letter die
 *     in de code aan een woord geplakt wordt.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/builderSplit/RefineDoneCard.test.jsx
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import RefineDoneCard from './RefineDoneCard';

// Zelfde vertaler als BuilderSplit.test.jsx: een string als tweede argument is
// de fallback, en {placeholders} worden echt ingevuld — dit bestand beweert
// dingen over de zin die de gebruiker leest ("Turned on 2 apps").
const t = (key, fallbackOrParams, paramsArg) => {
    const hasStringFallback = typeof fallbackOrParams === 'string';
    const params = hasStringFallback ? paramsArg : fallbackOrParams;
    let value = hasStringFallback ? fallbackOrParams : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) value = value.split(`{${k}}`).join(String(v));
    }
    return value;
};

afterEach(() => cleanup());

describe('RefineDoneCard — de wijzigingen', () => {
    it('noemt elke wijziging op zijn eigen regel', () => {
        render(<RefineDoneCard t={t} changes={[{ field: 'systemPrompt' }, { field: 'model' }]} />);
        const list = screen.getByTestId('refine-done-changes');
        expect(list.querySelectorAll('li').length).toBe(2);
        expect(list.textContent).toContain('Rewrote the instructions');
        expect(list.textContent).toContain('Changed the model');
    });

    it('zegt bij een lege diff dat er niets veranderde in plaats van een leeg lijstje', () => {
        render(<RefineDoneCard t={t} changes={[]} />);
        expect(screen.queryByTestId('refine-done-changes')).toBeNull();
        expect(screen.getByTestId('refine-done-nothing').textContent)
            .toBe('Nothing changed — the agent already worked that way.');
    });

    it('kiest enkelvoud en meervoud via de SLEUTEL, niet via een letter in de zin', () => {
        const { rerender } = render(<RefineDoneCard t={t} changes={[{ field: 'apps', direction: 'added', count: 1 }]} />);
        expect(screen.getByTestId('refine-done-changes').textContent).toContain('Turned on 1 app');
        rerender(<RefineDoneCard t={t} changes={[{ field: 'apps', direction: 'added', count: 3 }]} />);
        expect(screen.getByTestId('refine-done-changes').textContent).toContain('Turned on 3 apps');
    });

    it('scheidt aan- en uitzetten, en noemt skills en kennisbanken apart', () => {
        render(<RefineDoneCard t={t} changes={[
            { field: 'apps', direction: 'removed', count: 2 },
            { field: 'skills', direction: 'added', count: 1 },
            { field: 'knowledge', direction: 'added', count: 2 },
        ]} />);
        const text = screen.getByTestId('refine-done-changes').textContent;
        expect(text).toContain('Turned off 2 apps');
        expect(text).toContain('Attached 1 skill');
        expect(text).toContain('Added 2 knowledge bases');
    });

    it('slaat een wijziging over die het niet kent in plaats van een lege regel te tekenen', () => {
        render(<RefineDoneCard t={t} changes={[{ field: 'systemPrompt' }, { field: 'iets_nieuws' }]} />);
        expect(screen.getByTestId('refine-done-changes').querySelectorAll('li').length).toBe(1);
    });
});

describe('RefineDoneCard — ongedaan maken verdwijnt nooit stil', () => {
    it('herstelt op de nieuwste beurt met het herstelpunt eronder', () => {
        const onUndo = vi.fn();
        render(<RefineDoneCard t={t} changes={[{ field: 'name' }]} undoVersionId="v9" onUndo={onUndo} />);
        const btn = screen.getByTestId('refine-done-undo');
        expect(btn.getAttribute('data-undo-state')).toBe('idle');
        expect(btn.disabled).toBe(false);
        fireEvent.click(btn);
        expect(onUndo).toHaveBeenCalledWith('v9');
    });

    it('zonder herstelpunt staat de knop er NOG STEEDS, uit, met de reden', () => {
        const onUndo = vi.fn();
        render(<RefineDoneCard t={t} changes={[{ field: 'name' }]} undoVersionId={null} onUndo={onUndo} />);
        const btn = screen.getByTestId('refine-done-undo');
        expect(btn).toBeTruthy();
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute('data-undo-state')).toBe('unavailable');
        expect(btn.textContent).toContain('no restore point was saved');
        fireEvent.click(btn);
        expect(onUndo).not.toHaveBeenCalled();
    });

    it('een ingehaalde beurt zegt dat er iets nieuwers overheen ging — undo is één niveau diep', () => {
        const onUndo = vi.fn();
        render(<RefineDoneCard t={t} changes={[{ field: 'name' }]} undoVersionId="v9" superseded onUndo={onUndo} />);
        const btn = screen.getByTestId('refine-done-undo');
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute('data-undo-state')).toBe('superseded');
        expect(btn.textContent).toContain('a newer change came after this one');
        fireEvent.click(btn);
        expect(onUndo).not.toHaveBeenCalled();
    });

    it('een reeds herstelde beurt kan niet nog een keer', () => {
        const onUndo = vi.fn();
        render(<RefineDoneCard t={t} changes={[{ field: 'name' }]} undoVersionId="v9" undoState="undone" onUndo={onUndo} />);
        const btn = screen.getByTestId('refine-done-undo');
        expect(btn.disabled).toBe(true);
        expect(btn.textContent).toContain('Undone');
        fireEvent.click(btn);
        expect(onUndo).not.toHaveBeenCalled();
    });

    it('een mislukte restore zegt dat de agent ONVERANDERD is gebleven', () => {
        render(<RefineDoneCard t={t} changes={[{ field: 'name' }]} undoVersionId="v9" undoState="failed" />);
        expect(screen.getByTestId('refine-done-undo-failed').textContent)
            .toContain('the agent was left as it is');
    });
});

describe('RefineDoneCard — testen met een vraag', () => {
    it('biedt de test-actie altijd aan, ook als er niets te herstellen valt', () => {
        const onTest = vi.fn();
        render(<RefineDoneCard t={t} changes={[]} undoVersionId={null} onTest={onTest} />);
        fireEvent.click(screen.getByTestId('refine-done-test'));
        expect(onTest).toHaveBeenCalledTimes(1);
    });
});
