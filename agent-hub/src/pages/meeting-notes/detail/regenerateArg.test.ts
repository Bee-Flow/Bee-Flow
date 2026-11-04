/**
 * The "Speakers updated, regenerate?" banner rewrites the summary with the
 * template that wrote it, not with a fixed General (MN-026).
 */
import { describe, expect, it } from 'vitest';
import { regenerateArgForNote } from './regenerateArg';
import type { CustomTemplate, SummaryTemplates } from './summaryTemplates.types';

const sales: CustomTemplate = { id: 'tpl-sales-v3', name: 'Sales call v3', prompt: 'p', isDefault: false, version: 3, scope: 'org', groupId: null };
const mine: CustomTemplate = { id: 'tpl-mine', name: 'Mine', prompt: 'p', isDefault: true, version: 1, scope: 'user', groupId: null };

describe('regenerateArgForNote', () => {
    it('regenerates a built-in stamp with that built-in', () => {
        expect(regenerateArgForNote('builtin:sales', null)).toEqual({ template: 'sales' });
    });

    it('regenerates a saved-template stamp with that saved template', () => {
        expect(regenerateArgForNote('tpl-sales-v3', { custom: [sales] })).toEqual({ templateId: 'tpl-sales-v3' });
    });

    it('sends the saved template while the list has not loaded yet (the server checks it)', () => {
        expect(regenerateArgForNote('tpl-sales-v3', null)).toEqual({ templateId: 'tpl-sales-v3' });
    });

    it('falls back to the default template when the stamped one is no longer in the list', () => {
        const templates: SummaryTemplates = { custom: [mine], defaultTemplateId: 'tpl-mine' };
        expect(regenerateArgForNote('tpl-deleted', templates)).toEqual({ templateId: 'tpl-mine' });
    });

    it('falls back to the default template, then General, for a note without a stamp', () => {
        expect(regenerateArgForNote(null, { custom: [mine], defaultTemplateId: 'tpl-mine' })).toEqual({ templateId: 'tpl-mine' });
        expect(regenerateArgForNote('', null)).toEqual({ template: 'general' });
        expect(regenerateArgForNote('builtin:', null)).toEqual({ template: 'general' });
    });
});
