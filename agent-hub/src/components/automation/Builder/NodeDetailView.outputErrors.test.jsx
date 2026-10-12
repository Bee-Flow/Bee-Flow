import { readFileSync } from 'node:fs';
import path from 'node:path';
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// NDV fetches the tool catalog on mount — stub the API.
const { api } = vi.hoisted(() => ({
    api: { getCatalog: vi.fn().mockResolvedValue({ apps: [], triggerOutputs: {} }) },
}));
vi.mock('../../../hooks/useAutomationApi', () => ({ default: () => api }));

/**
 * A switchable dictionary over the REAL useTranslation, off by default.
 *
 * This is the only way these assertions can mean anything. With the shipped EN
 * defaults live, a hardcoded English sentence and a translated one render
 * byte-identically — which is exactly how the six refusal messages in the
 * output editor stayed English while the buttons around them (Remove, Cancel,
 * Save output, Output JSON) were translated. Switching the dictionary to Dutch
 * makes the difference visible: a string that still comes from a JS literal
 * stays English on a Dutch screen.
 */
const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
vi.mock('../../../hooks/useTranslation', async (importOriginal) =>
    (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

import {
    AI_STEP as step, AI_DEFINITION as definition, aiStepProps as baseProps, renderInQueryClient as render,
} from './ndv/ndvTestProps';
import NodeDetailView from './NodeDetailView';

const openEditor = () => fireEvent.click(screen.getByTestId('ndv-edit-output'));
const textarea = () => screen.getByLabelText('Output JSON');
const type = (value) => fireEvent.change(textarea(), { target: { value } });
const save = () => fireEvent.click(screen.getByText('Save output'));
const alertText = () => screen.getByRole('alert').textContent;

const reset = () => { cleanup(); transOverride.current = null; try { localStorage.clear(); } catch { /* ignore */ } };

describe('NodeDetailView — the output editor refuses in the user\'s language', () => {
    beforeEach(reset);

    it('speaks the invalid-JSON refusal through a key, and keeps the parser message', () => {
        transOverride.current = { 'automations.ndv.err_invalid_json': 'Ongeldige JSON: {message}' };
        render(<NodeDetailView {...baseProps()} />);
        openEditor();
        type('{ "subject": ');
        save();

        const text = alertText();
        expect(text).toMatch(/^Ongeldige JSON: /);
        // The parser's own words are DATA, not copy: they must survive the
        // placeholder, or the user is told "invalid" with no clue where.
        expect(text.length).toBeGreaterThan('Ongeldige JSON: '.length);
        expect(text).not.toMatch(/\{message\}/);
    });

    it('names the Remove button by its own key, so a rename cannot orphan the sentence', () => {
        // The bug this pins: the sentence said "use Remove", the button next to
        // it said common.remove. On a Dutch install the message pointed at a
        // button that is not on the screen.
        transOverride.current = {
            'automations.ndv.err_nothing_to_save': 'Niets op te slaan — gebruik {remove} om de bewaarde uitvoer te wissen.',
            'common.remove': 'Verwijderen',
        };
        // Mounted WITH a saved output, because that is the only state in which
        // the Remove button the sentence names is on screen at all.
        const pinned = { ...step, pinnedOutput: { id: 'x' }, pinnedAt: 'now', pinnedSource: 'edited' };
        const def = { ...definition, steps: [pinned] };
        render(<NodeDetailView {...baseProps({ step: pinned, definition: def, rootDefinition: def })} />);
        openEditor();
        type('null');
        save();

        expect(alertText()).toBe('Niets op te slaan — gebruik Verwijderen om de bewaarde uitvoer te wissen.');
        // …and the button it names really does carry that label.
        expect(screen.getByText('Verwijderen')).toBeTruthy();
    });

    it('speaks the truncation-sentinel refusal through a key', () => {
        transOverride.current = { 'automations.ndv.err_truncated_placeholder': 'Dat is de plaatsaanduiding van de server, geen gegevens.' };
        render(<NodeDetailView {...baseProps()} />);
        openEditor();
        type('{"__truncated__":true}');
        save();
        expect(alertText()).toBe('Dat is de plaatsaanduiding van de server, geen gegevens.');
    });

    it('speaks the size refusal through a key, with BOTH numbers as parameters', () => {
        // Grammar-in-code check: the two sizes must arrive as {size}/{limit},
        // not baked into a template literal, or a translator cannot move them.
        transOverride.current = { 'automations.ndv.err_too_big': 'Te groot: {size} KB, limiet {limit} KB.' };
        const onSaveStep = vi.fn().mockResolvedValue(undefined);
        render(<NodeDetailView {...baseProps({ onSaveStep })} />);
        openEditor();
        type(JSON.stringify({ body: 'x'.repeat(70_000) }));
        save();

        expect(alertText()).toMatch(/^Te groot: \d+ KB, limiet \d+ KB\.$/);
        expect(alertText()).not.toMatch(/\{size\}|\{limit\}/);
        expect(onSaveStep).not.toHaveBeenCalled();
    });

    it('leaves no refusal in this drawer that a translator cannot reach', () => {
        // The `bytes == null` branch (automations.ndv.err_not_json) is defensive:
        // JSON.parse cannot produce a value JSON.stringify refuses, so no click
        // path reaches it and no rendering assertion can pin it. Read the source
        // instead — every error this drawer SETS must come from t(), or from the
        // server's own message with t() behind it. That covers the six refusals
        // together, including the one the UI cannot be driven into.
        // jsdom hands this module a non-file import.meta.url, so resolve from
        // the vitest root (agent-hub/) instead.
        // The editor and the save machine live in ndv/ since the round-4 split.
        const src = ['ndv/useOutputEditor.tsx', 'ndv/useStepPatchSave.ts']
            .map(f => readFileSync(path.resolve(process.cwd(), 'src/components/automation/Builder', f), 'utf8'))
            .join('\n');
        const setters = [...src.matchAll(/set(?:Error|SaveError)\(([\s\S]{0,80})/g)]
            .map(m => m[1].trimStart())
            .filter(arg => !arg.startsWith('null'));
        expect(setters.length).toBeGreaterThanOrEqual(6);
        for (const arg of setters) {
            // t(…) itself, or the server's own message with t() behind it.
            expect(/^(t\(|[\w?.() ]+?\|\| t\()/.test(arg)).toBe(true);
        }
        // …and the pre-fix SHAPES are gone. Each of these can only occur in a
        // hardcoded literal, never inside a t() fallback argument.
        for (const gone of [
            'Invalid JSON: ${',                       // grammar baked by a template literal
            "'Nothing to save — use Remove",          // the button named as prose
            "e.message || 'Save failed'",             // untranslated fallback
            "setOutEditError('That value",            // bare literal into the alert
            'Too big to save: ${',                    // two numbers baked in
        ]) {
            expect(src).not.toContain(gone);
        }
    });

});

describe('NodeDetailView — a failed save says so in the user\'s language', () => {
    beforeEach(reset);

    it('speaks the save-failure through ONE key shared by both failure paths', async () => {
        transOverride.current = { 'automations.ndv.save_failed': 'Opslaan mislukt' };
        // A rejection WITHOUT a message: the fallback branch is what carries the
        // copy, and that is the branch that was hardcoded English.
        const onSaveStep = vi.fn().mockRejectedValue(new Error(''));
        render(<NodeDetailView {...baseProps({ onSaveStep })} />);
        openEditor();
        type('{"ok":true}');
        save();

        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Opslaan mislukt'));
    });

    it('leaves the server\'s own message alone when it has one', async () => {
        // The key is a FALLBACK for a silent failure, never a replacement for
        // what the server said.
        transOverride.current = { 'automations.ndv.save_failed': 'Opslaan mislukt' };
        const onSaveStep = vi.fn().mockRejectedValue(new Error('definition too large'));
        render(<NodeDetailView {...baseProps({ onSaveStep })} />);
        openEditor();
        type('{"ok":true}');
        save();

        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('definition too large'));
    });
});
