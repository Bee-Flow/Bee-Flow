import { describe, it, expect } from 'vitest';
import { titleFromBrief, TITLE_IN_BRIEF_RE } from './AutomationStage';

/**
 * The seed title the automation stage reads off its brief — the same pattern
 * server/automation/builderTools/deriveTitle.js applies, so both sides name
 * the automation identically.
 */
describe('AutomationStage titleFromBrief', () => {
    it('reads Title "…" off the playbook brief, in either language and any quote style', () => {
        expect(titleFromBrief('**Rules:** do not create a table or columns. Keep file order. Title "Facturen inlezen".')).toBe('Facturen inlezen');
        expect(titleFromBrief('Titel: “Facturen goedkeuren”')).toBe('Facturen goedkeuren');
        expect(titleFromBrief("Naam 'Nieuwe klanten' graag")).toBe('Nieuwe klanten');
        expect(titleFromBrief('App name "Facturen". Finish with app_finalize.')).toBe('Facturen');
    });

    it('is null when the brief states no title, and clamps a long one to 60', () => {
        expect(titleFromBrief('## Build an automation\nI start it by hand.')).toBeNull();
        expect(titleFromBrief(null)).toBeNull();
        expect(titleFromBrief(`Title "${'x'.repeat(100)}"`)).toHaveLength(60);
        expect(TITLE_IN_BRIEF_RE.flags).toBe('i');
    });

    it('reads a statement, not any "name" before a quote — a field name mid-sentence seeds nothing', () => {
        // The server derives nothing from these either (deriveTitle.test.js);
        // a seed of "From" would name the automation wrongly from its first byte.
        expect(titleFromBrief('Put the sender name "From" and the subject in a Slack message every morning at 9')).toBeNull();
        expect(titleFromBrief('Maak een tabel met kolom naam "Leverancier" en zet elke factuur erin')).toBeNull();
        expect(titleFromBrief('Title "ab"')).toBeNull();
        // An apostrophe inside a single-quoted title is part of it.
        expect(titleFromBrief("Title: 'It's a test of the naming'")).toBe("It's a test of the naming");
        expect(titleFromBrief('- Name: "Weekly digest"\n- every Monday')).toBe('Weekly digest');
    });
});
