import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { LanguagePicker } from './LoginChrome';

// `t()` returns the source's own fallback, or the bare key when there is none.
vi.mock('../../hooks/useTranslation', () => import('@/test/useTranslationMock'));

const LOCALES = [{ code: 'en' }, { code: 'nl' }];

describe('LanguagePicker', () => {
    it('gives the select a name: its options are only two-letter codes', () => {
        render(<LanguagePicker availableLocales={LOCALES} locale="en" setLocale={vi.fn()} />);
        const select = screen.getByRole('combobox', { name: 'Language' });
        expect(select).toHaveValue('en');
    });

    it('switches the locale to the chosen option', async () => {
        const user = userEvent.setup();
        const setLocale = vi.fn();
        render(<LanguagePicker availableLocales={LOCALES} locale="en" setLocale={setLocale} />);
        await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'nl');
        expect(setLocale).toHaveBeenCalledWith('nl');
    });

    it('is not offered when the server lists a single locale', () => {
        const { container } = render(<LanguagePicker availableLocales={[{ code: 'en' }]} locale="en" setLocale={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
    });
});
