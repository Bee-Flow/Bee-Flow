/**
 * types.mts: the shapes shared by the integration page content (facts.mts, the
 * per-language prose in en/ and nl/) and the model built from them
 * (model.mts). Types only, so the language modules depend on nothing.
 */

export type ContentLocale = 'en' | 'nl';

/** The hand-written part of one integration page, in one language. */
export interface Prose {
    /** The `<title>` before the site-name suffix; with " | Bee Flow" at most 58 characters. */
    title: string;
    /** Meta description, at most 155 characters. */
    description: string;
    /** One line for the directory card. */
    summary: string;
    /** The integration's name in the h1 when it differs from the catalogue title (a Dutch app name). */
    name?: string;
    /** What it is and what it is for. */
    intro: readonly string[];
    /** One sentence per tool group of facts.mts, by group key. */
    groups: Readonly<Record<string, string>>;
    /** How it is connected and with whose permissions. */
    connect: readonly string[];
    /** Limits, stated plainly. */
    limits: readonly string[];
    /** Requests a person could make, each one possible with the tools listed. */
    examples?: readonly string[];
}

/** The fixed words of the pages in one language. `{x}` marks a value filled in at render time. */
export interface Ui {
    navIntegrations: string;
    navDirectory: string;
    navBlog: string;
    directoryTitle: string;
    directoryHeading: string;
    directoryLead: string;
    /** `{count}` */
    directoryDescription: string;
    searchLabel: string;
    categoryLabel: string;
    allCategories: string;
    searchButton: string;
    /** `{shown}`, `{total}` */
    countLine: string;
    clearFilters: string;
    noMatch: string;
    breadcrumbDirectory: string;
    canDo: string;
    toolsLabel: string;
    otherTools: string;
    effect: Readonly<Record<Effect, string>>;
    access: string;
    accessText: Readonly<Record<Effect, string>>;
    events: string;
    eventsNone: string;
    eventsConnector: string;
    eventsPublicUrl: string;
    connect: string;
    gate: string;
    limits: string;
    examples: string;
    related: string;
    /** `{category}` */
    moreIn: string;
    browseAll: string;
    overview: string;
    deployment: string;
    plans: string;
}

export interface LocaleContent {
    locale: ContentLocale;
    ui: Ui;
    prose: Readonly<Record<string, Prose>>;
    /** Event labels by `provider:event`; the registry's own (English) label is the fallback. */
    eventLabels: Readonly<Record<string, string>>;
    /** Category names by catalogue category; the catalogue's own name is the fallback. */
    categories: Readonly<Record<string, string>>;
}

export type Effect = 'reads' | 'writes' | 'sends';
