import { Bookmark, CloudOff, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAutomationTemplates } from '../../../../api/queries/automation/templates';
import type { TemplateCard } from '../../../../api/queries/automation/templates';
import { useTranslation } from '../../../../hooks/useTranslation';
import TemplateTile from './TemplateTile';

export interface TemplateGalleryProps {
    /** Creates a draft from the template and opens it; may be async. */
    onPick?: (templateId: string, tmpl: TemplateCard) => unknown;
}

/** Categories in the order the templates bring them, with how many each has. */
export function categoryCounts(templates: TemplateCard[]): Array<{ name: string; count: number }> {
    const counts = new Map<string, number>();
    for (const tm of templates) if (tm.category) counts.set(tm.category, (counts.get(tm.category) || 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count }));
}

/** Search reads the title, the sentence, the category, the tags and the apps. */
export function matchesTemplate(tm: TemplateCard, query: string, category: string | null): boolean {
    if (category && tm.category !== category) return false;
    if (!query) return true;
    const hay = [tm.title, tm.description, tm.category || '', ...tm.tags, ...tm.requiredIntegrations].join(' ').toLowerCase();
    return hay.includes(query);
}

/**
 * The Templates tab (Studio → Automations, handoff 5 language): a header
 * with one line of explanation, a search field and category chips taken from
 * the templates themselves, then "Your organisation" (what colleagues saved
 * with "Save as template", with who and when) above "Bee Flow templates".
 * Picking one calls `onPick(templateId, template)`; the parent creates a
 * draft from it and opens the builder.
 */
export default function TemplateGallery({ onPick }: TemplateGalleryProps) {
    const { t } = useTranslation();
    const query = useAutomationTemplates();
    const [search, setSearch] = useState('');
    const [category, setCategory] = useState<string | null>(null);
    const [openingId, setOpeningId] = useState<string | null>(null);

    const templates = useMemo(() => query.data || [], [query.data]);
    const q = search.trim().toLowerCase();
    const visible = useMemo(() => templates.filter(tm => matchesTemplate(tm, q, category)), [templates, q, category]);

    const use = async (tm: TemplateCard) => {
        if (openingId) return;
        setOpeningId(tm.id);
        try { await onPick?.(tm.id, tm); } finally { setOpeningId(null); }
    };
    const grid = (rows: TemplateCard[]) => (
        // More columns as the gallery widens (its own width, not the
        // viewport's): two in the laptop column, four in an ultrawide's.
        <div className="grid grid-cols-1 @[34rem]/templates:grid-cols-2 @[56rem]/templates:grid-cols-3 @[76rem]/templates:grid-cols-4 gap-2.5">
            {rows.map(tm => (
                <TemplateTile key={tm.id} tmpl={tm} busy={openingId === tm.id} disabled={!!openingId} onUse={use} />
            ))}
        </div>
    );

    let body: ReactNode;
    if (query.isLoading) {
        body = <p className="m-0 text-[12px] text-[var(--text-tertiary)]">{t('routines.templates.loading', 'Loading templates…')}</p>;
    } else if (query.isError && templates.length === 0) {
        // One calm sentence and a way to try again. The server's own words
        // ("Not found", a status line) are for the logs, not for this page.
        // A failed REfetch keeps the templates already on screen instead.
        body = <LoadFailed retrying={query.isFetching} onRetry={() => { query.refetch(); }} />;
    } else {
        body = <Sections visible={visible} filtering={!!q || !!category} grid={grid} onClear={() => { setSearch(''); setCategory(null); }} />;
    }

    return (
        <div className="@container/templates flex flex-col gap-5">
            <header className="flex flex-col gap-1">
                <h2 className="m-0 text-[15px] font-semibold text-[var(--text-primary)]">{t('routines.templates.title', 'Templates')}</h2>
                <p className="m-0 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
                    {t('routines.templates.intro', 'Start from a flow that is already wired up, then change whatever you like. Your organisation’s own templates come first.')}
                </p>
            </header>
            {templates.length > 0 && (
                <Filters templates={templates} search={search} onSearch={setSearch} category={category} onCategory={setCategory} />
            )}
            {body}
        </div>
    );
}

/** The list could not be read: said plainly, with Try again (the Notice of Find repeating work). */
function LoadFailed({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div role="alert" className="flex items-start gap-3 px-4 py-3.5 rounded-[10px] border border-dashed border-[var(--border-default)]" data-testid="templates-load-failed">
            <CloudOff size={16} aria-hidden="true" className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" />
            <div className="min-w-0 flex-1">
                <p className="m-0 text-[13px] text-[var(--text-primary)]">
                    {t('routines.templates.loadFailed', 'The templates could not be loaded.')}
                </p>
                <button
                    type="button"
                    onClick={onRetry}
                    disabled={retrying}
                    className="mt-2 px-3 py-1.5 rounded-lg text-[12px] font-medium border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition disabled:opacity-50"
                >
                    {t('routines.templates.retry', 'Try again')}
                </button>
            </div>
        </div>
    );
}

/** "Your organisation" above "Bee Flow templates", or why nothing shows. */
function Sections({ visible, filtering, grid, onClear }: {
    visible: TemplateCard[];
    filtering: boolean;
    grid: (rows: TemplateCard[]) => ReactNode;
    onClear: () => void;
}) {
    const { t } = useTranslation();
    const org = visible.filter(tm => tm.source === 'org');
    const builtIn = visible.filter(tm => tm.source !== 'org');
    if (filtering && visible.length === 0) {
        return (
            <p className="m-0 text-[12px] text-[var(--text-secondary)]">
                {t('routines.templates.noMatch', 'No template matches.')}{' '}
                <button type="button" onClick={onClear} className="underline text-[var(--text-primary)]">
                    {t('routines.templates.clear', 'Clear the search')}
                </button>
            </p>
        );
    }
    // While searching, a section without matches is left out; otherwise the
    // organisation's always shows, empty or not, so people learn it exists.
    const showOrg = !filtering || org.length > 0;
    return (
        <>
            {showOrg && (
                <Section title={t('routines.templates.yourOrganisation', 'Your organisation')} count={org.length} testId="templates-org">
                    {org.length > 0 ? grid(org) : <OrgEmpty />}
                </Section>
            )}
            {showOrg && builtIn.length > 0 && <div className="h-px bg-[var(--border-default)]" />}
            {builtIn.length > 0 && (
                <Section title={t('routines.templates.beeFlow', 'Bee Flow templates')} count={builtIn.length} testId="templates-builtin">
                    {grid(builtIn)}
                </Section>
            )}
        </>
    );
}

/** The search field and the category chips. */
function Filters({ templates, search, onSearch, category, onCategory }: {
    templates: TemplateCard[];
    search: string;
    onSearch: (next: string) => void;
    category: string | null;
    onCategory: (next: string | null) => void;
}) {
    const { t } = useTranslation();
    const categories = useMemo(() => categoryCounts(templates), [templates]);
    return (
        // Narrow: the search above the chips. From 56rem the search keeps a
        // sensible width and the chips run beside it, instead of a search
        // field stretched across an ultrawide column.
        <div className="flex flex-col gap-2.5 @[56rem]/templates:flex-row @[56rem]/templates:items-center @[56rem]/templates:gap-4">
            <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg @[56rem]/templates:w-80 @[56rem]/templates:flex-shrink-0 border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] text-[var(--text-tertiary)] focus-within:border-[var(--accent-primary)]">
                <Search size={13} aria-hidden="true" />
                <input
                    type="search"
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                    placeholder={t('routines.templates.searchPlaceholder', 'Search templates…')}
                    aria-label={t('routines.templates.search', 'Search templates')}
                    className="flex-1 min-w-0 bg-transparent outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                />
                {search && (
                    <button type="button" onClick={() => onSearch('')} aria-label={t('routines.templates.clear', 'Clear the search')} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                        <X size={12} aria-hidden="true" />
                    </button>
                )}
            </label>
            {categories.length > 0 && (
                <CategoryChips categories={categories} value={category} onChange={onCategory} total={templates.length} />
            )}
        </div>
    );
}

function Section({ title, count, testId, children }: { title: string; count: number; testId: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-2.5" data-testid={testId}>
            <h3 className="m-0 flex items-baseline gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                <span>{title}</span>
                <span className="text-[11px] font-normal text-[var(--text-tertiary)]">{count}</span>
            </h3>
            {children}
        </section>
    );
}

/** Where an organisation's templates come from, said once. */
function OrgEmpty() {
    const { t } = useTranslation();
    return (
        <div className="flex items-start gap-3 px-3.5 py-3 rounded-[10px] border border-dashed border-[var(--border-default)]" data-testid="templates-org-empty">
            <Bookmark size={15} aria-hidden="true" className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" />
            <div className="min-w-0">
                <div className="text-[12.5px] font-medium text-[var(--text-primary)]">{t('routines.templates.orgEmptyTitle', 'Nothing saved yet')}</div>
                <p className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-tertiary)]">
                    {t('routines.templates.orgEmptyBody', 'Save one of your automations as a template and colleagues can start from it too: open it, then Settings → General → Save as template.')}
                </p>
            </div>
        </div>
    );
}

function CategoryChips({ categories, value, onChange, total }: {
    categories: Array<{ name: string; count: number }>;
    value: string | null;
    onChange: (next: string | null) => void;
    total: number;
}) {
    const { t } = useTranslation();
    const chip = (active: boolean) => `inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] transition ${
        active
            ? 'border-[var(--text-tertiary)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-medium'
            : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'
    }`;
    return (
        <div role="group" aria-label={t('routines.templates.categories', 'Categories')} className="flex flex-wrap gap-1.5">
            <button type="button" aria-pressed={value === null} onClick={() => onChange(null)} className={chip(value === null)}>
                {t('routines.templates.all', 'All')}
                <span className="text-[var(--text-tertiary)]">{total}</span>
            </button>
            {categories.map(c => (
                <button key={c.name} type="button" aria-pressed={value === c.name} onClick={() => onChange(value === c.name ? null : c.name)} className={chip(value === c.name)}>
                    {c.name}
                    <span className="text-[var(--text-tertiary)]">{c.count}</span>
                </button>
            ))}
        </div>
    );
}
