/**
 * model.mts: what one public integration page shows, in one language, built
 * from the hand-written prose (en.mts, nl.mts), the language-neutral facts
 * (facts.mts) and the shipped catalogues the caller hands in: the toolsets,
 * the trigger-source registry and the side-effect classification.
 *
 * Every list on a page comes from those catalogues at render time. A tool or an
 * event that is not in them is left out, never shown from the prose alone, so a
 * page cannot advertise something the product does not ship. Whether a line
 * reads, changes or sends is the side-effect map's answer, not the author's.
 * The HTML itself is written by core/seo/integrationsDirectory.js.
 */

import { FACTS, type IntegrationFacts } from './facts.mts';
import { EN } from './en.mts';
import { NL } from './nl.mts';
import type { ContentLocale, Effect, LocaleContent, Prose } from './types.mts';

export type { ContentLocale, Effect, LocaleContent, Prose, Ui } from './types.mts';
export { FACTS } from './facts.mts';

export const CONTENT_LOCALES: readonly ContentLocale[] = ['en', 'nl'];
const CONTENT: Readonly<Record<ContentLocale, LocaleContent>> = { en: EN, nl: NL };
const EFFECT_ORDER: readonly Effect[] = ['reads', 'writes', 'sends'];

export interface ToolDefLike { function?: { name?: string } }
export interface TriggerEventLike { id: string; label?: string; hidden?: boolean; source?: { kind?: string } }
export interface TriggerSourceLike {
    id: string;
    hidden?: boolean;
    availability?: { requiresPublicBaseUrl?: boolean };
    events?: readonly TriggerEventLike[];
}

/** The shipped catalogues a page is checked against. */
export interface Catalog {
    toolsets: Readonly<Record<string, readonly ToolDefLike[] | undefined>>;
    triggerSources: readonly TriggerSourceLike[];
    effectOf: (toolName: string) => string;
}

export interface PageLine { text: string; tools: string[]; effect: Effect | null }
export interface PageEvent { label: string; viaConnector: boolean }

export interface PageModel {
    prose: Prose;
    lines: PageLine[];
    otherTools: string[];
    /** null: the integration declares no events (the page says it has none). */
    events: PageEvent[] | null;
    /** Some event is pushed by the vendor and needs a server reachable from the internet. */
    eventsNeedPublicUrl: boolean;
    /** The strongest effect of all shipped tools; null when the page has no read/write section. */
    access: Effect | null;
    related: string[];
}

function isContentLocale(locale: string): locale is ContentLocale {
    return (CONTENT_LOCALES as readonly string[]).includes(locale);
}

/** The words of a language, English when the site's language has none. */
export function localeContent(locale: string): LocaleContent {
    return isContentLocale(locale) ? CONTENT[locale] : EN;
}

/** The prose of one integration in one language, or null. */
export function proseFor(id: string, locale: string): Prose | null {
    if (!isContentLocale(locale) || !Object.hasOwn(FACTS, id)) return null;
    return Object.hasOwn(CONTENT[locale].prose, id) ? CONTENT[locale].prose[id] : null;
}

/**
 * Is there a page in this language? The directory (id null) exists in every
 * content language; an integration page in the languages its prose is written
 * in; one without prose only in English, its catalogue line.
 */
export function hasPageIn(id: string | null, locale: string): boolean {
    if (!isContentLocale(locale)) return false;
    if (id === null) return true;
    if (!Object.hasOwn(FACTS, id)) return locale === 'en';
    return proseFor(id, locale) !== null;
}

/** The locales a page may be advertised in (hreflang, sitemap): the default first, then each site locale with a page. */
export function pageLocales(id: string | null, siteLocales: readonly string[], defaultLocale: string): string[] {
    return [defaultLocale, ...siteLocales.filter(l => l !== defaultLocale && hasPageIn(id, l))];
}

function strongest(effects: readonly string[]): Effect {
    let best = 0;
    for (const e of effects) {
        const i = EFFECT_ORDER.indexOf(e as Effect);
        best = Math.max(best, i === -1 ? 1 : i);
    }
    return EFFECT_ORDER[best];
}

function shippedToolNames(facts: IntegrationFacts, catalog: Catalog): Set<string> {
    const names = (catalog.toolsets[facts.toolset] || []).map(t => t?.function?.name).filter((n): n is string => typeof n === 'string');
    return new Set(names);
}

function buildLines(facts: IntegrationFacts, prose: Prose, shipped: Set<string>, catalog: Catalog): PageLine[] {
    const lines: PageLine[] = [];
    for (const group of facts.groups) {
        const tools = group.tools.filter(t => shipped.has(t));
        const text = Object.hasOwn(prose.groups, group.key) ? prose.groups[group.key] : '';
        if (!tools.length || !text) continue;
        lines.push({ text, tools, effect: facts.effects === false ? null : strongest(tools.map(catalog.effectOf)) });
    }
    return lines;
}

function buildEvents(facts: IntegrationFacts, content: LocaleContent, catalog: Catalog): Pick<PageModel, 'events' | 'eventsNeedPublicUrl'> {
    if (!facts.events) return { events: null, eventsNeedPublicUrl: false };
    const events: PageEvent[] = [];
    let publicUrl = false;
    for (const rule of facts.events) {
        const source = catalog.triggerSources.find(s => s.id === rule.provider && !s.hidden);
        const matching = (source?.events || []).filter(e => !e.hidden && (!rule.prefix || e.id.startsWith(rule.prefix)));
        if (source && matching.length && source.availability?.requiresPublicBaseUrl) publicUrl = true;
        for (const e of matching) {
            const key = `${rule.provider}:${e.id}`;
            const label = Object.hasOwn(content.eventLabels, key) ? content.eventLabels[key] : (e.label || e.id);
            events.push({ label, viaConnector: rule.provider === 'nextcloud' && e.source?.kind === 'push' });
        }
    }
    return { events, eventsNeedPublicUrl: publicUrl };
}

/** The page of one integration in one language, or null when it has no prose in that language. */
export function buildPageModel(id: string, locale: string, catalog: Catalog): PageModel | null {
    const prose = proseFor(id, locale);
    if (!prose) return null;
    const facts = FACTS[id];
    const content = localeContent(locale);
    const shipped = shippedToolNames(facts, catalog);
    const grouped = new Set(facts.groups.flatMap(gr => gr.tools));
    const otherTools = [...shipped].filter(t => !grouped.has(t));
    const lines = buildLines(facts, prose, shipped, catalog);
    return {
        prose,
        lines,
        otherTools,
        ...buildEvents(facts, content, catalog),
        access: facts.effects === false || shipped.size === 0 ? null : strongest([...shipped].map(catalog.effectOf)),
        related: [...(facts.related || [])],
    };
}

/** The directory card line of an integration in a language, or null (the caller keeps the catalogue line). */
export function summaryFor(id: string, locale: string): string | null {
    return proseFor(id, locale)?.summary ?? null;
}
