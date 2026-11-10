// Tests that pin a component's exact class string (the identity of a stored app) compare it
// without the `bfa-<type>__<part>` tokens: those are the part classes custom CSS targets, they
// change no look, and the DOM gate (appLookRegression.ts) drops them the same way.
export function withoutPartClasses(className: string | null | undefined): string {
    return (className || '').split(/\s+/).filter((token) => token && !token.startsWith('bfa-')).join(' ');
}
