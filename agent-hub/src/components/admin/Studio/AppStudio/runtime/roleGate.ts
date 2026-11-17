/**
 * PRESENTATIONAL role gate: may the active viewer role see this screen, node or
 * nav entry? A missing or empty visibleToRoles means "everyone"; a null role or
 * the owner sentinel disables gating (full view). One rule for the renderer, the
 * URL route and the nav, so a screen the viewer cannot open is never offered.
 * Real row-level security is server-enforced; this is never a security control.
 */
export function roleAllows(gated: { visibleToRoles?: unknown } | null | undefined, previewRole: string | null | undefined): boolean {
    if (!previewRole || previewRole === 'owner') return true;
    const gate = gated && gated.visibleToRoles;
    if (!Array.isArray(gate) || gate.length === 0) return true;
    return gate.includes(previewRole);
}
