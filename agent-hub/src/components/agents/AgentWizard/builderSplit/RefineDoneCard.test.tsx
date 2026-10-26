/**
 * The "Done: …" turn of the refine rail (A2 step 5).
 *
 * What is pinned here is exactly what a next stage could accidentally reverse:
 *   - an EMPTY diff is a SENTENCE ("nothing changed"), not an empty list;
 *   - the undo button NEVER DISAPPEARS: without a restore point, or on an
 *     overtaken turn, it is still there, disabled, with the reason;
 *   - a disabled button does not call onUndo. That is the difference between
 *     "doing nothing" and "restoring something DIFFERENT";
 *   - the singular/plural choice is a KEY choice (nOf), not a letter glued onto
 *     a word in the code.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/builderSplit/RefineDoneCard.test.jsx
 */
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

import RefineDoneCard from './RefineDoneCard';
import type { TranslateParams } from '@/hooks/useTranslation';

// Same translator as BuilderSplit.test.jsx: a string as second argument is
// the fallback, and {placeholders} are really filled in. This file asserts
// things about the sentence the user reads ("Turned on 2 apps").
const t = (key: string, fallbackOrParams?: string | TranslateParams, paramsArg?: TranslateParams | null) => {
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
    it('herstelt op de nieuwste beurt met het herstelpunt eronder', async () => {
        const user = userEvent.setup();
        const onUndo = vi.fn();
        render(<RefineDoneCard t={t} changes={[{ field: 'name' }]} undoVersionId="v9" onUndo={onUndo} />);
        const btn = screen.getByTestId('refine-done-undo');
        expect(btn.getAttribute('data-undo-state')).toBe('idle');
        expect((btn as HTMLInputElement).disabled).toBe(false);
        await user.click(btn);
        expect(onUndo).toHaveBeenCalledWith('v9');
    });

    it('zonder herstelpunt staat de knop er NOG STEEDS, uit, met de reden', async () => {
        const user = userEvent.setup();
        const onUndo = vi.fn();
        render(<RefineDoneCard t={t} changes={[{ field: 'name' }]} undoVersionId={null} onUndo={onUndo} />);
        const btn = screen.getByTestId('refine-done-undo');
        expect(btn).toBeTruthy();
        expect((btn as HTMLInputElement).disabled).toBe(true);
        expect(btn.getAttribute('data-undo-state')).toBe('unavailable');
        expect(btn.textContent).toContain('no restore point was saved');
        await user.click(btn);
        expect(onUndo).not.toHaveBeenCalled();
    });

    it('een ingehaalde beurt zegt dat er iets nieuwers overheen ging — undo is één niveau diep', async () => {
        const user = userEvent.setup();
        const onUndo = vi.fn();
        render(<RefineDoneCard t={t} changes={[{ field: 'name' }]} undoVersionId="v9" superseded onUndo={onUndo} />);
        const btn = screen.getByTestId('refine-done-undo');
        expect((btn as HTMLInputElement).disabled).toBe(true);
        expect(btn.getAttribute('data-undo-state')).toBe('superseded');
        expect(btn.textContent).toContain('a newer change came after this one');
        await user.click(btn);
        expect(onUndo).not.toHaveBeenCalled();
    });

    it('een reeds herstelde beurt kan niet nog een keer', async () => {
        const user = userEvent.setup();
        const onUndo = vi.fn();
        render(<RefineDoneCard t={t} changes={[{ field: 'name' }]} undoVersionId="v9" undoState="undone" onUndo={onUndo} />);
        const btn = screen.getByTestId('refine-done-undo');
        expect((btn as HTMLInputElement).disabled).toBe(true);
        expect(btn.textContent).toContain('Undone');
        await user.click(btn);
        expect(onUndo).not.toHaveBeenCalled();
    });

    it('een mislukte restore zegt dat de agent ONVERANDERD is gebleven', () => {
        render(<RefineDoneCard t={t} changes={[{ field: 'name' }]} undoVersionId="v9" undoState="failed" />);
        expect(screen.getByTestId('refine-done-undo-failed').textContent)
            .toContain('the agent was left as it is');
    });
});

describe('RefineDoneCard — testen met een vraag', () => {
    it('biedt de test-actie altijd aan, ook als er niets te herstellen valt', async () => {
        const user = userEvent.setup();
        const onTest = vi.fn();
        render(<RefineDoneCard t={t} changes={[]} undoVersionId={null} onTest={onTest} />);
        await user.click(screen.getByTestId('refine-done-test'));
        expect(onTest).toHaveBeenCalledTimes(1);
    });
});
