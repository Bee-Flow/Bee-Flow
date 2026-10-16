/**
 * The language a public feature demo (/__demo__/<feature>?lang=nl) was framed
 * for, or null. The marketing page tells the demo which language ITS page is in;
 * the demo is a separate document, so it must not guess from the visitor's
 * stored or browser language. Only a well-formed code on a demo path counts —
 * a locale this deployment does not have simply falls back to the English
 * catalogue (the available-locales gate below).
 */
export function demoLangOverride(pathname: string, search: string): string | null {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored literal with one alternation and no repetition: linear
    if (!/^\/__demo__(\/|$)/.test(pathname)) return null;
    const lang = new URLSearchParams(search).get('lang');
    if (!lang || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) return null;
    return lang.split('-')[0].toLowerCase();
}
