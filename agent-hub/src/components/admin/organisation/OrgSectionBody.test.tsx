// The width of an Organisation section's page: the forms at the settings width,
// the lists and tables at the whole pane.
import { describe, expect, it } from 'vitest';
import { orgSectionWidth } from './OrgSectionBody';

describe('orgSectionWidth', () => {
    it('puts the forms at the settings width, Models among them', () => {
        for (const section of ['info', 'conversations', 'memory', 'models', 'encryption', 'meeting-notes']) {
            expect(orgSectionWidth(section)).toBe('settings');
        }
    });

    it('gives the lists the whole pane', () => {
        for (const section of ['knowledge-bases', 'academy', 'mcp']) {
            expect(orgSectionWidth(section)).toBe('wide');
        }
    });
});
