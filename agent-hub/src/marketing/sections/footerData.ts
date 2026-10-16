import type {
    FooterAccountability, FooterColumn, FooterData, FooterLink, FooterSocial,
} from './Footer.types';

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** A list the footer maps over: anything that is not an array of objects reads as empty. */
function objectList<T>(v: unknown): T[] {
    return Array.isArray(v) ? (v.filter(isObject) as T[]) : [];
}

/**
 * The footer's stored settings come from the CMS, so a wrong-typed value is
 * possible (a string where a list belongs). Lists become arrays of objects
 * and nested objects become objects, so the renderer never calls `.map` on a
 * string. Scalar fields are left alone: React renders them or ignores them.
 */
export function normalizeFooterData(data: FooterData | null | undefined): FooterData | null {
    if (!isObject(data)) return null;
    const columns = objectList<FooterColumn>(data.columns).map((col) => ({
        ...col,
        links: objectList<FooterLink>(col.links),
    }));
    const acc: FooterAccountability | undefined = isObject(data.accountability)
        ? { ...data.accountability, links: objectList<FooterLink>(data.accountability.links) }
        : undefined;
    const socials = objectList<FooterSocial>(data.socials);
    return {
        ...data,
        columns,
        socials,
        accountability: acc,
        brand: isObject(data.brand) ? data.brand : undefined,
        themeSwitcher: isObject(data.themeSwitcher) ? data.themeSwitcher : undefined,
    };
}
