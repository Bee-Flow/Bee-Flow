import { describe, expect, it } from 'vitest';
import { SETTINGS_GROUPS, normaliseSettings } from './settingsFields';
import {
    groupProgress, isAnswered, sectionsOf, spanOf, type SettingsForm, type SettingsGroupSpec,
} from './settingsLayout';

const groups = SETTINGS_GROUPS as unknown as SettingsGroupSpec[];
const group = (id: string) => groups.find(g => g.id === id) as SettingsGroupSpec;

describe('settingsLayout', () => {
    it('short inputs take half a row, lists and toggles the whole row, unless the table says otherwise', () => {
        expect(spanOf({ name: 'x', kind: 'text' })).toBe('half');
        expect(spanOf({ name: 'x', kind: 'date' })).toBe('half');
        expect(spanOf({ name: 'x', kind: 'toggle' })).toBe('full');
        expect(spanOf({ name: 'x', kind: 'contacts' })).toBe('full');
        expect(spanOf({ name: 'x', kind: 'text', span: 'third' })).toBe('third');
    });

    it('the DPO name, e-mail and phone share one row, as do the three day fields', () => {
        const general = group('general');
        const span = (name: string) => spanOf(general.fields.find(f => f.name === name)!);
        expect(['dpo_name', 'dpo_email', 'dpo_phone'].map(span)).toEqual(['third', 'third', 'third']);
        expect(['default_retention_days', 'datatable_review_days', 'project_retention_days'].map(span)).toEqual(['third', 'third', 'third']);
    });

    it('splits General into its four sections, in order, and loses no field', () => {
        const general = group('general');
        const sections = sectionsOf(general);
        expect(sections.map(s => s.id)).toEqual(['accountability', 'lawful', 'public', 'alerts']);
        expect(sections.flatMap(s => s.fields).length).toBe(general.fields.length);
        expect(sections[0].fields.map(f => f.name)).toEqual(['dpo_user', 'dpo_name', 'dpo_email', 'dpo_phone']);
        expect(sections[3].fields.map(f => f.name)).toEqual(['breach_recipients', 'sso_enforces_mfa', 'project_owner_hints_enabled']);
    });

    it('a group without sections is one untitled section', () => {
        const nis2 = sectionsOf(group('nis2'));
        expect(nis2).toHaveLength(1);
        expect(nis2[0].titleKey).toBeNull();
    });

    it('counts answered questions, leaving out toggles, the member picker, optional and hidden fields', () => {
        const empty = normaliseSettings(null) as SettingsForm;
        expect(groupProgress(group('ai_act'), empty)).toEqual({ answered: 0, total: 1 });
        expect(groupProgress(group('ai_act'), { ...empty, ai_literacy_confirmed_at: '2026-08-16T10:00:00Z' })).toEqual({ answered: 1, total: 1 });
        const general = groupProgress(group('general'), empty);
        expect(general.total).toBe(9);
        expect(general.answered).toBe(0);
    });

    it('a relevance question is answered once it is not "unknown"', () => {
        const dora = group('dora');
        const empty = normaliseSettings(null) as SettingsForm;
        expect(groupProgress(dora, empty, () => 'unknown').answered).toBe(0);
        expect(groupProgress(dora, empty, () => 'relevant').answered).toBe(1);
        expect(isAnswered({ name: 'x', kind: 'text' }, '   ')).toBe(false);
        expect(isAnswered({ name: 'x', kind: 'emails' }, ['a@b.c'])).toBe(true);
    });
});
