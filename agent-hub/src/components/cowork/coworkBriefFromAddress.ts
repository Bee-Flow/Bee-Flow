/** The `brief` of the address, if any ("Make it a cowork", ./CoworkHabitChip.tsx); read once, when Cowork opens. */
export function briefFromAddress(): string {
    try {
        return new URLSearchParams(window.location.search).get('brief')?.slice(0, 4000) ?? '';
    } catch {
        return '';
    }
}
