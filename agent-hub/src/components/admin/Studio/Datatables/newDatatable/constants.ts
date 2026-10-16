export const INPUT = 'w-full px-3 py-2 rounded-lg text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1';
// --bg-primary, not --bg-secondary: the Modal panel is itself --bg-secondary,
// so an input painted the same colour has no edge at all.
export const INPUT_STYLE = {
    background: 'var(--bg-primary)', borderColor: 'var(--border-default)',
    color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)',
};
export const BTN = 'px-3 py-2 rounded-[10px] text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

/**
 * The permission POST /api/datatables asks for before it will put a table in
 * an organisation — spelled exactly as the server spells it, because this
 * string is what an administrator types into Organisation → Roles.
 */
export const ORG_SCOPE_PERMISSION = 'manage_datatables';
