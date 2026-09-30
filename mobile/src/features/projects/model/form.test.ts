/**
 * The project form's body: blank text is sent as null ("none"), the name is
 * trimmed, the version rides along only on an edit — and a Blueprint file is
 * only ever a JSON object. Plus which tabs a Solution shows, and to whom.
 */

import { parseBlueprint } from './blueprintFile';
import { bodyFrom, draftFrom, EMPTY_DRAFT, PROJECT_COLORS, PROJECT_ICONS } from './form';
import { activeTab, isSolutionTab, visibleTabs } from './tabs';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: jest.fn() }));

describe('the project form', () => {
    it('sends blank text as null and trims the name', () => {
        expect(bodyFrom({ ...EMPTY_DRAFT, name: '  Intake ', description: '   ' })).toEqual({
            name: 'Intake',
            description: null,
            customInstructions: null,
            icon: '📦',
            color: '#6366f1',
        });
    });

    it('carries the version it was opened on, on an edit only', () => {
        expect(bodyFrom(EMPTY_DRAFT, 7).version).toBe(7);
        expect('version' in bodyFrom(EMPTY_DRAFT)).toBe(false);
    });

    it('seeds from a project, with the defaults where it has none', () => {
        expect(draftFrom({ name: 'X', description: null, customInstructions: 'Be brief', icon: null, color: null })).toEqual({
            name: 'X',
            description: '',
            customInstructions: 'Be brief',
            icon: '📦',
            color: '#6366f1',
        });
    });

    it('offers the web’s palettes', () => {
        expect(PROJECT_COLORS).toHaveLength(10);
        expect(PROJECT_ICONS).toContain('📁');
    });
});

describe('parseBlueprint', () => {
    it('accepts only a JSON object', () => {
        expect(parseBlueprint('{"solution":{}}')).toEqual({ solution: {} });
        expect(parseBlueprint('[1,2]')).toBeNull();
        expect(parseBlueprint('null')).toBeNull();
        expect(parseBlueprint('not json')).toBeNull();
    });
});

describe('the Solution tabs', () => {
    it('shows Versions and Installs to the owner on a plan with packaging only', () => {
        expect(visibleTabs({ isOwner: true, packaging: true })).toContain('versions');
        expect(visibleTabs({ isOwner: false, packaging: true })).not.toContain('installs');
        expect(visibleTabs({ isOwner: true, packaging: false })).not.toContain('versions');
        expect(visibleTabs({ isOwner: false, packaging: false })).toHaveLength(7);
    });

    it('falls back to Content for a tab that is not there', () => {
        expect(isSolutionTab('flow')).toBe(true);
        expect(isSolutionTab('danger')).toBe(false);
        expect(activeTab('versions', visibleTabs({ isOwner: false, packaging: true }))).toBe('content');
        expect(activeTab('members', visibleTabs({ isOwner: false, packaging: true }))).toBe('members');
    });
});
