// What AI work cost, as money: one amount per currency the usage ledger kept it in (an organisation that changed
// plans has calls in two). Shared by the App Studio run views and Cowork's run history.

/** "$0.0021 · €0.0100", each in its own currency; '—' without a priced call. */
export function formatCost(costByCurrency: Record<string, number> | null | undefined, locale = 'en'): string {
    const entries = Object.entries(costByCurrency ?? {}).filter(([, v]) => Number.isFinite(v));
    if (!entries.length) return '—';
    return entries.map(([currency, value]) => {
        try {
            return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: value < 0.01 ? 4 : 2 }).format(value);
        } catch {
            return `${value.toFixed(4)} ${currency}`;
        }
    }).join(' · ');
}
