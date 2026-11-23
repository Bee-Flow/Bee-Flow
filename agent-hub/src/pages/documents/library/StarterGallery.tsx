// Starting a new document, grouped by what it is for: Write (a page; a
// notebook, a page with sources and an assistant that reads them), Calculate
// (a spreadsheet), For customers (a blank customer document or a starter with
// fields filled in per customer), Present (a presentation), and the reader's
// own templates. In the Templates and Reusable sections views only what can be
// one there is offered: a page, notebook or spreadsheet is never a template.

import { BookOpen, FileChartColumn, FilePenLine, FileText, HandCoins, LayoutTemplate, Mail, Presentation, Receipt, Sheet, ShieldCheck, type LucideIcon } from 'lucide-react';
import React from 'react';
import Modal from '@/components/shared/Modal';
import useTranslation, { readingLocale } from '@/hooks/useTranslation';
import { useStarters, type Starter } from '../documentQueries';

/** One of the reader's own templates, copied into a new document. */
export interface OwnTemplate { id: string; name: string; docType?: string }

export type NewChoice = { type: 'page' } | { type: 'notebook' } | { type: 'spreadsheet' } | { type: 'template'; template: OwnTemplate } | { type: 'designed'; starter: Starter | null } | { type: 'deck'; starter: Starter | null };

/** The library view the gallery was opened from. */
type GalleryView = 'document' | 'template' | 'section';

export interface StarterGalleryProps {
    open: boolean;
    busy: boolean;
    error: string | null;
    /** Offer a notebook: only to a reader the server lists notebooks for. */
    notebooks?: boolean;
    /** Offer a spreadsheet: only to a reader who may use spreadsheets. */
    spreadsheets?: boolean;
    /** The reader's own templates, offered in the documents view. */
    templates?: OwnTemplate[];
    /** Templates and reusable sections offer only what can be one (default: documents). */
    view?: GalleryView;
    onChoose: (choice: NewChoice) => void;
    onClose: () => void;
}

const ICONS: Record<string, LucideIcon> = {
    page: FileText, notebook: BookOpen, spreadsheet: Sheet, document: FilePenLine, presentation: Presentation,
    invoice: Receipt, quote: HandCoins, letter: Mail, report: FileChartColumn, security: ShieldCheck,
};

/** One icon per type; a starter or template of another type gets the template icon. */
function docTypeIcon(docType: string | undefined): LucideIcon {
    return (docType && ICONS[docType]) || LayoutTemplate;
}

const TILE = 'flex min-w-0 flex-col items-start gap-1 p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-left hover:border-[var(--accent-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';

function Tile({ docType, title, hint, onClick, busy, testId }: { docType: string | undefined; title: string; hint?: string; onClick: () => void; busy: boolean; testId?: string }) {
    return (
        <button type="button" className={TILE} disabled={busy} onClick={onClick} data-testid={testId}>
            <span className="text-[var(--accent-primary)]" aria-hidden="true">{React.createElement(docTypeIcon(docType), { size: 20 })}</span>
            <strong className="max-w-full text-sm text-[var(--text-primary)] [overflow-wrap:anywhere]">{title}</strong>
            {hint && <span className="max-w-full text-xs text-[var(--text-tertiary)] [overflow-wrap:anywhere]">{hint}</span>}
        </button>
    );
}

function Group({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
    return (
        <section aria-labelledby={id}>
            <h3 id={id} className="text-sm font-semibold mb-1 text-[var(--text-primary)]">{title}</h3>
            {hint && <p className="text-xs mb-2 text-[var(--text-tertiary)]">{hint}</p>}
            <div className="grid sm:grid-cols-2 gap-3 mt-2">{children}</div>
        </section>
    );
}

type Translate = ReturnType<typeof useTranslation>['t'];

/** "3 fields to fill in"; nothing for a starter without fields. */
function fieldsHint(starter: Starter, t: Translate): string | undefined {
    const count = starter.settings?.contract?.parameters?.length || 0;
    if (!count) return undefined;
    return count === 1 ? t('doc_gallery.fields_one', '1 field to fill in') : t('doc_gallery.fields', '{count} fields to fill in', { count });
}

interface GroupProps { props: StarterGalleryProps; t: Translate }

function WriteGroups({ props, t }: GroupProps) {
    const { busy, onChoose, notebooks = false, spreadsheets = false } = props;
    return (
        <>
            <Group id="doc-gallery-write" title={t('doc_gallery.group_write', 'Write')}>
                <Tile docType="page" title={t('documents.new.page', 'Page')} hint={t('doc_gallery.page_hint', 'Write freely, on your own or together in real time. Prints in the house style.')} busy={busy} onClick={() => onChoose({ type: 'page' })} testId="documents-new-page" />
                {notebooks && (
                    <Tile docType="notebook" title={t('documents.notebook.new', 'Notebook')} hint={t('documents.notebook.new_hint', 'Add files, websites and notes as sources; the assistant answers from them and helps you write.')} busy={busy} onClick={() => onChoose({ type: 'notebook' })} testId="documents-new-notebook" />
                )}
            </Group>
            {spreadsheets && (
                <Group id="doc-gallery-calculate" title={t('doc_gallery.group_calculate', 'Calculate')}>
                    <Tile docType="spreadsheet" title={t('documents.sheet.new', 'Spreadsheet')} hint={t('doc_gallery.sheet_hint', 'Rows, columns and formulas like =SUM(A1:A9). Apps and automations can read it.')} busy={busy} onClick={() => onChoose({ type: 'spreadsheet' })} testId="documents-new-spreadsheet" />
                </Group>
            )}
        </>
    );
}

function CustomerGroup({ props, t, starters }: GroupProps & { starters: ReturnType<typeof useStarters> }) {
    const { busy, onChoose } = props;
    const list = (starters.data || []).filter((s) => s.docType !== 'presentation');
    return (
        <Group id="doc-gallery-customers" title={t('doc_gallery.group_customers', 'For customers')}>
            <Tile docType="document" title={t('doc_gallery.blank_customer', 'Blank customer document')} hint={t('doc_gallery.customer_hint', 'A laid-out document such as a quote or letter, with fields you fill in per customer.')} busy={busy} onClick={() => onChoose({ type: 'designed', starter: null })} testId="documents-new-designed" />
            {list.map((s) => <Tile key={s.id} docType={s.docType} title={s.name} hint={fieldsHint(s, t)} busy={busy} onClick={() => onChoose({ type: 'designed', starter: s })} />)}
            {starters.isPending && <p className="text-xs text-[var(--text-tertiary)]" role="status">{t('documents.new.loading', 'Loading templates…')}</p>}
            {starters.isError && <p className="text-xs text-[var(--error)]" role="alert">{t('documents.new.load_failed', 'The templates could not be loaded.')}</p>}
        </Group>
    );
}

function PresentGroup({ props, t, starters }: GroupProps & { starters: ReturnType<typeof useStarters> }) {
    const { busy, onChoose } = props;
    const decks = (starters.data || []).filter((s) => s.docType === 'presentation');
    return (
        <Group id="doc-gallery-present" title={t('doc_gallery.group_present', 'Present')} hint={t('documents.new.presentations_hint', 'Slides in the house style: an outline you type, viewed here and downloaded as PowerPoint or PDF.')}>
            <Tile docType="presentation" title={t('documents.new.blank_deck', 'Blank presentation')} busy={busy} onClick={() => onChoose({ type: 'deck', starter: null })} testId="documents-new-presentation" />
            {decks.map((s) => <Tile key={s.id} docType="presentation" title={s.name} hint={fieldsHint(s, t)} busy={busy} onClick={() => onChoose({ type: 'deck', starter: s })} />)}
        </Group>
    );
}

function OwnTemplatesGroup({ props, t }: GroupProps) {
    const { busy, onChoose, templates = [] } = props;
    return (
        <Group id="doc-gallery-own" title={t('documents.new.own_templates', 'Your templates')}>
            {templates.map((tpl) => (
                <Tile key={tpl.id} docType={tpl.docType} title={tpl.name} busy={busy} onClick={() => onChoose({ type: 'template', template: tpl })} testId={`documents-new-template-${tpl.id}`} />
            ))}
        </Group>
    );
}

/** Why the Templates or Reusable sections view offers fewer types. */
function viewNote(view: GalleryView, t: Translate): string | null {
    if (view === 'template') return t('doc_gallery.only_in_documents', 'Pages, notebooks and spreadsheets are made in Documents.');
    if (view === 'section') return t('doc_gallery.only_in_documents_section', 'Pages, notebooks and spreadsheets are made in Documents. A presentation cannot be a reusable section.');
    return null;
}

export default function StarterGallery(props: StarterGalleryProps) {
    const { open, busy, error, onClose, view = 'document', templates = [] } = props;
    const { t, locale: preferred, strings } = useTranslation();
    const starters = useStarters(readingLocale(preferred, strings, ['documents.new.title']) || 'en', open);
    const note = viewNote(view, t);
    return (
        <Modal open={open} onClose={onClose} title={t('documents.new.title', 'Start a document')} size="lg" disableEscapeClose={busy}>
            <div className="space-y-5" data-testid="document-gallery">
                {error && <p role="alert" className="text-[12px] text-[var(--error)]">{error}</p>}
                {note && <p className="text-xs text-[var(--text-secondary)]" data-testid="document-gallery-note">{note}</p>}
                {view === 'document' && <WriteGroups props={props} t={t} />}
                <CustomerGroup props={props} t={t} starters={starters} />
                {view !== 'section' && <PresentGroup props={props} t={t} starters={starters} />}
                {view === 'document' && templates.length > 0 && <OwnTemplatesGroup props={props} t={t} />}
            </div>
        </Modal>
    );
}
