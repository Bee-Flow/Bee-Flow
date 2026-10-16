import type { CmsLocaleOverrides } from './cmsPanelTypes';

type OverrideMap = Record<string, Record<string, unknown> | undefined>;

/**
 * Fold the overrides a page/site save returned (the server re-aligned the
 * translations to the item order it just stored) into the in-memory copy.
 * `scope` is 'site' or a page id. A locale whose edit is still queued
 * (`hasPending`) is left alone. Returns the same object when nothing applies.
 */
export function adoptRealignedOverrides(
    prev: CmsLocaleOverrides,
    scope: string,
    moved: unknown,
    hasPending: (locale: string) => boolean,
): CmsLocaleOverrides {
    if (!moved || typeof moved !== 'object') return prev;
    const fresh = Object.fromEntries(
        Object.entries(moved as OverrideMap).filter(([locale]) => !hasPending(locale)),
    );
    if (!Object.keys(fresh).length) return prev;
    if (scope === 'site') return { ...prev, siteByLocale: { ...prev.siteByLocale, ...fresh } };
    return {
        ...prev,
        pagesByLocale: { ...prev.pagesByLocale, [scope]: { ...prev.pagesByLocale?.[scope], ...fresh } },
    };
}
