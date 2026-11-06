/**
 * Data-driven widths and colours cannot be static classes, so they are set on
 * the element through its ref (no `style={{}}` object).
 */
export function paint(el: HTMLElement | null, props: Record<string, string>) {
    if (!el) return;
    for (const [name, value] of Object.entries(props)) el.style.setProperty(name, value);
}
