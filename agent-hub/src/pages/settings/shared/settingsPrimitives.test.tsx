import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LANGS, languageOptions } from './settingsPrimitives';
import { LANGUAGES } from '@/config/meetingNotesConfig';

function LanguageSelect({ value }: { value: string }) {
    return (
        <select aria-label="Default language" value={value} onChange={() => {}}>
            {languageOptions(value).map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
    );
}

function shownLabel(): string | null {
    const sel = screen.getByRole('combobox', { name: 'Default language' }) as HTMLSelectElement;
    return sel.options[sel.selectedIndex]?.textContent ?? null;
}

describe('meeting-notes language options', () => {
    it('offers every transcription language the recorder and mobile offer, without the flag', () => {
        expect(LANGS.map(l => l.code)).toEqual(LANGUAGES.map(l => l.code));
        expect(LANGS.find(l => l.code === 'pl')?.label).toBe('Polish');
        expect(LANGS[0]).toEqual({ code: 'nl', label: 'Dutch' });
    });

    it('shows a stored language set on mobile as itself, not as Dutch', () => {
        render(<LanguageSelect value="pl" />);
        expect(shownLabel()).toBe('Polish');
    });

    it('keeps a stored code the list does not know and shows it as itself', () => {
        render(<LanguageSelect value="auto" />);
        expect(shownLabel()).toBe('auto');
        expect(languageOptions('pt-br')[0]).toEqual({ code: 'pt-br', label: 'pt-br' });
    });

    it('adds nothing for a known or empty value', () => {
        expect(languageOptions('en')).toBe(LANGS);
        expect(languageOptions('')).toBe(LANGS);
        expect(languageOptions(undefined)).toBe(LANGS);
    });
});
