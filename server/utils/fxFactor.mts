/**
 * The factor that turns an amount in currency `from` into currency `to`,
 * through the USD-based rate table of core/text/currency (`rateOf(c)` is how
 * many units of `c` one USD buys; `currency_fx_usd_<c>`).
 *
 * A leaf on purpose: the rate lookup is handed in, so a module inside the
 * server's big import cycle (stores/usage/logUsage.js gets the currency helper
 * through a lazy loader) can share it without requiring the currency helper at
 * load time. core/text/currency `fxFactor` is the same function with the real
 * lookup bound.
 *
 * `strict` is passed through to the lookup: a strict lookup that fails throws,
 * and this does not catch it. A rate that cannot be inverted or divided gives
 * NaN, never a guess; the caller decides what a missing rate means.
 */

export type UsdRateLookup = (currency: string, opts: { strict: boolean }) => Promise<number> | number;

const usable = (rate: number): boolean => Number.isFinite(rate) && rate > 0;

export async function fxFactorVia(rateOf: UsdRateLookup, from: string, to: string, strict = false): Promise<number> {
    if (from === 'USD') return rateOf(to, { strict });
    if (to === 'USD') {
        const r = await rateOf(from, { strict });
        return usable(r) ? 1 / r : NaN;
    }
    const [rFrom, rTo] = await Promise.all([rateOf(from, { strict }), rateOf(to, { strict })]);
    return usable(rFrom) && usable(rTo) ? rTo / rFrom : NaN;
}
