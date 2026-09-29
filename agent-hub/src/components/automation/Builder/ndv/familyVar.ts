// One custom property per step family, written out literally so Tailwind
// generates every class: set `--fam` on a container, then paint children with
// `bg-[var(--fam)]`, `text-[var(--fam)]` or a color-mix of it. Replaces the
// inline `style={{ color: typeColorVar(family) }}` objects.
const FAMILY_VAR: Record<string, string> = {
    trigger: '[--fam:var(--type-trigger)]', ai: '[--fam:var(--type-ai)]', app: '[--fam:var(--type-app)]',
    branch: '[--fam:var(--type-branch)]', loop: '[--fam:var(--type-loop)]', data: '[--fam:var(--type-data)]',
    pause: '[--fam:var(--type-pause)]', guard: '[--fam:var(--type-guard)]', end: '[--fam:var(--type-end)]',
};

/** The class that sets `--fam` for a family; a neutral ink for none. */
export function familyVarClass(family: string | null | undefined): string {
    return (family && FAMILY_VAR[family]) || '[--fam:var(--text-tertiary)]';
}
