// Shared useTranslation mock whose `t` fills `{name}` placeholders from its
// params argument (see `tParams` in ./i18n). Opt in from a test with:
//   vi.mock('.../hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));
import { tParams } from './i18n';

const value = { t: tParams, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} as Record<string, string> };

export function useTranslation() {
    return value;
}

export function TranslationProvider({ children }: { children: unknown }) {
    return children;
}

export function ensureI18nDefaults(): Promise<void> {
    return Promise.resolve();
}

export default useTranslation;
