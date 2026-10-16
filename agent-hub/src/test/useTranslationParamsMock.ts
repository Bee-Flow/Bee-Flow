// Shared useTranslation mock whose `t` fills `{name}` placeholders from its
// params argument (see `tParams` in ./i18n). Opt in from a test with:
//   vi.mock('.../hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));
// It exports only the named hook, like the inline factories it replaces.
import { tParams } from './i18n';

export function useTranslation() {
    return { t: tParams };
}
