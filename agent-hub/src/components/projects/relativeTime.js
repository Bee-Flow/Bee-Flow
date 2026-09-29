/**
 * "just now" / "5m ago" / "3h ago" — the compact timestamp every project
 * surface uses. Shared between the collaboration project page and the Studio
 * Solutions workspace, which must not import each other: the project page is a
 * heavy chunk and Solutions is lazy-loaded, so a helper this small is the only
 * thing they are allowed to have in common.
 */
export function formatRelative(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const sec = Math.round(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.round(hr / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
}
