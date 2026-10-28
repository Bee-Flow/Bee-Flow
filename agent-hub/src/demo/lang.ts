import { demoLangOverride } from '../hooks/demoLang';

/**
 * The language of the demo's SAMPLE DATA. The UI chrome follows the app's own
 * i18n; the fixtures (agent names, ticket subjects, notebook text, ...) are
 * data, so they carry their own copy per language. A demo framed by a Dutch
 * page (?lang=nl) shows Dutch sample text, every other page shows English.
 */
export type DemoLang = 'en' | 'nl';

function demoLang(): DemoLang {
    if (typeof window === 'undefined') return 'en';
    return demoLangOverride(window.location.pathname, window.location.search) === 'nl' ? 'nl' : 'en';
}

type PickObserver = (chosen: unknown, other: unknown) => void;
let observer: PickObserver | null = null;

/** Test seam: sees the copy that pick() chose and the copy it left out. */
export function observePicks(fn: PickObserver | null): void {
    observer = fn;
}

/** Pick the copy for the current demo language. */
export function pick<T>(copy: { en: T; nl: T }, lang: DemoLang = demoLang()): T {
    if (observer) observer(copy[lang], lang === 'nl' ? copy.en : copy.nl);
    return copy[lang];
}
