// The crisp check the Cowork tests share (./CoworkPage.test.tsx, ./task/CoworkTaskView.test.tsx): what holds text may
// carry no class that draws it soft while it is at rest.

// What "crisp" forbids on anything that holds text, at rest: a transform, a filter, a backdrop filter, will-change.
const SOFT = /^-?(translate|scale|rotate|skew)-|^transform(-|$)|^(blur|backdrop|will-change|brightness|contrast|grayscale|saturate|drop-shadow)-|^(blur|filter|grayscale)$|^animate-(spin|bounce|ping|fade-in)$|^(bf-step-in|sidebar-slide-in|modal-slide-in-\w+)$/;
// Not at rest (a pointer or a key is on it), or not the element itself (a part drawn before or after it).
const NOT_AT_REST = /^(hover|active|focus|focus-visible|focus-within|group-hover|peer-hover|enabled:hover|after|before|peer-checked:after|peer-focus-visible)$/;

/** The classes of `root` and everything in it that hold text and would be drawn soft. */
export function softClasses(root: HTMLElement): string[] {
    const found: string[] = [];
    for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
        if (!(el.textContent ?? '').trim()) continue;
        for (const token of el.getAttribute('class')?.split(/\s+/) ?? []) {
            const parts = token.split(':');
            const utility = parts[parts.length - 1];
            if (parts.slice(0, -1).some((variant) => NOT_AT_REST.test(variant))) continue;
            if (SOFT.test(utility)) found.push(`${el.tagName.toLowerCase()}.${token}`);
        }
    }
    return found;
}
