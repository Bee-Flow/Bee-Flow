import useTranslation from '@/hooks/useTranslation';
import PageCanvas from './PageCanvas';
import type { ChangeRegion } from './pdfCompareMath';
import type { PdfDocHandle } from './pdfTypes';

const MAX_THUMBS = 80;

/** A narrow strip of page thumbnails; pages with changes carry a red count badge. */
export default function ThumbStrip({ doc, numPages, page, byPage, onSelect }: {
    doc: PdfDocHandle;
    numPages: number;
    page: number;
    byPage: Record<number, ChangeRegion[] | undefined>;
    onSelect: (n: number) => void;
}) {
    const { t } = useTranslation();
    const shown = Math.min(numPages, MAX_THUMBS);
    return (
        <nav
            className="flex w-[84px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-[var(--border-default)] bg-[var(--bg-tertiary)] p-2"
            aria-label={t('studio_apps_runtime.pdf_compare.thumbs', 'Pages')}
            data-pdf-thumbs="true"
        >
            {Array.from({ length: shown }, (_, i) => {
                const n = i + 1;
                const count = byPage[n]?.length || 0;
                return (
                    <button
                        key={n}
                        type="button"
                        onClick={() => onSelect(n)}
                        aria-current={n === page ? 'page' : undefined}
                        aria-label={t('studio_apps_runtime.pdf_compare.go_to_page', 'Page {n}', { n })}
                        className={`relative flex shrink-0 flex-col items-center gap-0.5 rounded border p-0.5 ${n === page ? 'border-[var(--app-accent,#2563eb)] bg-[var(--bg-primary)]' : 'border-transparent hover:border-[var(--border-default)]'}`}
                    >
                        <PageCanvas doc={doc} pageNumber={n} cssWidth={60} />
                        <span className="text-[11px] text-[var(--text-secondary)]">{n}</span>
                        {count > 0 ? (
                            <span
                                className="absolute -right-1 -top-1 min-w-[16px] rounded-full bg-red-500 px-1 text-center text-[10px] font-semibold leading-4 text-white"
                                data-pdf-thumb-badge={count}
                            >
                                {count}
                            </span>
                        ) : null}
                    </button>
                );
            })}
        </nav>
    );
}
