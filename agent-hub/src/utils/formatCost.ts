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

/**
 * "€0.62", "< €0.01": what AI work cost, to the cent, the way Cowork says it everywhere (a run, a month, a budget).
 * Always two decimals, so a column of costs lines up; anything above zero and below a cent is "< €0.01" rather than
 * a fourth decimal beside a second. Zero is "€0.00"; '—' without a priced call.
 */
export function formatCostCents(costByCurrency: Record<string, number> | null | undefined, locale = 'en'): string {
    const entries = Object.entries(costByCurrency ?? {}).filter(([, v]) => Number.isFinite(v));
    if (!entries.length) return '—';
    return entries.map(([currency, value]) => {
        const below = value > 0 && value < 0.01;
        try {
            const money = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(below ? 0.01 : value);
            return below ? `< ${money}` : money;
        } catch {
            return below ? `< 0.01 ${currency}` : `${value.toFixed(2)} ${currency}`;
        }
    }).join(' · ');
}
