import { describe, expect, it, vi } from 'vitest';
import { askModelForRules } from './routeRulesRequest';

/**
 * The model fallback's request: field NAMES only, and only real fields. The
 * rule menu's "File type" entries are a function over a field
 * (`fileType(item)`), not a path the model may declare; the model learns
 * fileType() from the server's rule hint instead.
 */
describe('askModelForRules', () => {
    it('sends the field names without samples and without the File type entries', async () => {
        const suggestRouteRules = vi.fn().mockResolvedValue({ rules: [], problem: '' });
        await askModelForRules({ suggestRouteRules }, {
            description: ' split the mails ',
            fields: [
                { path: 'item.subject', label: 'Subject', sample: 'Offer Fabrikam' },
                { path: 'fileType(item.attachments[*])', label: 'File type', sample: 'pdf', kind: 'fileType' },
                { path: 'fileType(item)', label: 'File type', sample: 'pdf', kind: 'fileType' },
                { path: 'item.attachments[*].filename', label: 'Filename', sample: 'offer.pdf', quantified: true },
            ],
            itemVar: 'item',
            perItem: true,
        });
        expect(suggestRouteRules).toHaveBeenCalledWith({
            description: 'split the mails',
            fields: [
                { key: 'item.subject', name: 'Subject', type: '' },
                { key: 'item.attachments[*].filename', name: 'Filename', type: '' },
            ],
            itemVar: 'item',
            perItem: true,
        });
    });
});
