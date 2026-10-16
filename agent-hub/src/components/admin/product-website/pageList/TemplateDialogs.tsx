import { useRef, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { AppIcon } from '../fieldKit/jsDeps';
import { ModalShell, formatTemplateDate, slugIssues } from './pageListShared';
import type { NewPageInput, PageTemplate } from './pageListShared';

type TFn = ReturnType<typeof useTranslation>['t'];

function blockCountLabel(t: TFn, n: number | undefined): string {
    return n === 1
        ? t('cms_site.site.pagelist.block_count_one', '{n} block', { n })
        : t('cms_site.site.pagelist.block_count_other', '{n} blocks', { n });
}

const FIELD_CLS = 'w-full px-3 py-2 rounded-md text-sm border bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]';

function TemplateCard({ selected, onClick, title, subtitle }: { selected: boolean; onClick: () => void; title?: string; subtitle?: string }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={
                'w-full text-left px-3 py-2 rounded-md border transition-colors ' +
                (selected
                    ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10'
                    : 'border-[var(--border-default)] bg-[var(--bg-tertiary)] hover:border-[var(--accent-primary)]/60')
            }
        >
            <div className="flex items-center gap-2">
                <span
                    className={
                        'w-3 h-3 rounded-full shrink-0 border ' +
                        (selected
                            ? 'bg-[var(--accent-primary)] border-[var(--accent-primary)]'
                            : 'border-[var(--border-default)]')
                    }
                    aria-hidden="true"
                />
                <span className="text-sm text-[var(--text-primary)] font-medium truncate">{title}</span>
            </div>
            {subtitle ? (
                <div className="ml-5 mt-0.5 text-[11px] text-[var(--text-muted)] truncate">{subtitle}</div>
            ) : null}
        </button>
    );
}

/** The "Start from" picker: blank page plus one card per saved template. */
function TemplatePicker({ templates, templateId, onPick }: { templates: PageTemplate[]; templateId: string; onPick: (id: string) => void }) {
    const { t } = useTranslation();
    return (
        <>
            <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-2">
                {t('cms_site.site.pagelist.start_from', 'Start from')}
            </p>
            <div className="flex flex-col gap-1.5 mb-3">
                <TemplateCard
                    selected={templateId === ''}
                    onClick={() => onPick('')}
                    title={t('cms_site.site.pagelist.blank_page', 'Blank page')}
                    subtitle={t('cms_site.site.pagelist.blank_page_sub', 'No blocks — start from scratch')}
                />
                {templates.map(tpl => (
                    <TemplateCard
                        key={tpl.id}
                        selected={templateId === tpl.id}
                        onClick={() => onPick(tpl.id)}
                        title={tpl.name}
                        subtitle={
                            tpl.description
                                ? `${tpl.description} · ${blockCountLabel(t, tpl.blockCount)}`
                                : blockCountLabel(t, tpl.blockCount)
                        }
                    />
                ))}
            </div>
        </>
    );
}

// ── Add page dialog ──────────────────────────────────────────────────
//
// A ModalShell dialog (used to live inline at the top of the pages list).
// When templates exist, a "Start from" picker is appended below the slug
// input — picking a template causes the new page to be seeded with a
// deep copy of the template's blocks (fresh ids generated server-side).

interface AddPageDialogProps {
    onConfirm: (input: NewPageInput) => void;
    onCancel: () => void;
    templates?: PageTemplate[];
    existingSlugs?: Array<string | undefined>;
}

const deriveSlug = (title: string) =>
    title.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 64);

export function AddPageDialog({ onConfirm, onCancel, templates = [], existingSlugs = [] }: AddPageDialogProps) {
    const { t } = useTranslation();
    const [title, setTitle]            = useState('');
    const [slug, setSlug]              = useState('');
    const [templateId, setTemplateId]  = useState('');   // '' = blank
    const slugAuto = useRef(true);

    const handleTitleChange = (v: string) => {
        setTitle(v);
        if (slugAuto.current) setSlug(deriveSlug(v));
    };
    const handleSlugChange = (v: string) => {
        slugAuto.current = false;
        setSlug(v.toLowerCase().replace(/[^a-z0-9_-]/g, ''));
    };
    const issue = slugIssues(slug, { existingSlugs });

    return (
        <ModalShell onClose={onCancel} labelledBy="add-page-title">
            <div className="p-5">
            <p id="add-page-title" className="text-sm font-semibold text-[var(--text-primary)] mb-3">{t('cms_site.site.pagelist.new_page', 'New page')}</p>
            <input
                autoFocus
                type="text"
                placeholder={t('cms_site.site.pagelist.page_title_placeholder', 'Page title')}
                value={title}
                onChange={e => handleTitleChange(e.target.value)}
                className={`${FIELD_CLS} mb-2`}
            />
            <input
                type="text"
                placeholder={t('cms_site.site.pagelist.slug_auto_placeholder', 'slug (auto)')}
                value={slug}
                onChange={e => handleSlugChange(e.target.value)}
                className={`${FIELD_CLS} mb-1 font-mono`}
            />
            {issue ? (
                <p className={`text-[10px] leading-tight mb-2 ${issue.blocking ? 'text-red-400' : 'text-amber-500/90'}`}>
                    ⚠ {issue.message}
                </p>
            ) : <span className="block mb-2" />}

            {/* "Start from" — only when there's at least one saved template.
                Hidden completely otherwise so the empty state stays clean. */}
            {templates.length > 0 ? (
                <TemplatePicker templates={templates} templateId={templateId} onPick={setTemplateId} />
            ) : null}

            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={() => onConfirm({ title, slug, templateId: templateId || undefined })}
                    disabled={!title.trim() || !!issue?.blocking}
                    className="flex-1 px-3 py-1.5 text-sm rounded-md bg-[var(--accent-primary)] text-white disabled:opacity-40"
                >
                    {t('cms_site.site.pagelist.add_page', 'Add page')}
                </button>
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-3 py-1.5 text-sm rounded-md border border-[var(--border-default)] text-[var(--text-secondary)]"
                >
                    {t('cms_site.site.pagelist.cancel', 'Cancel')}
                </button>
            </div>
            </div>
        </ModalShell>
    );
}

// The old local ModalOverlay grew into the shared ./dialogs/ModalShell —
// same markup and behavior (Esc + backdrop close, aria-modal), plus
// width presets. All three dialogs here use it.

// ── Save-as-template dialog ──────────────────────────────────────────

interface SaveTemplateDialogProps {
    page?: { title?: string } | null;
    onConfirm: (input: { name: string; description: string }) => unknown;
    onCancel: () => void;
}

export function SaveTemplateDialog({ page, onConfirm, onCancel }: SaveTemplateDialogProps) {
    const { t } = useTranslation();
    const [name, setName]               = useState(page?.title || '');
    const [description, setDescription] = useState('');
    const [saving, setSaving]           = useState(false);
    const trimmed = name.trim();
    return (
        <ModalShell onClose={onCancel} labelledBy="save-tpl-title">
            <div className="p-5">
                <h3 id="save-tpl-title" className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                    {t('cms_site.site.pagelist.save_as_template', 'Save as template')}
                </h3>
                <p className="text-xs text-[var(--text-muted)] mb-4">
                    {t('cms_site.site.pagelist.save_as_template_help', "Save this page's blocks as a reusable template. You can apply it from the New page dialog.")}
                </p>
                <label className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">
                    {t('cms_site.site.pagelist.template_name', 'Template name')}
                </label>
                <input
                    autoFocus
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder={t('cms_site.site.pagelist.template_name_placeholder', 'Solution page')}
                    className={`${FIELD_CLS} mt-1 mb-3`}
                />
                <label className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">
                    {t('cms_site.site.pagelist.description_optional', 'Description (optional)')}
                </label>
                <input
                    type="text"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder={t('cms_site.site.pagelist.description_placeholder', 'Short one-liner shown when picking a template')}
                    className={`${FIELD_CLS} mt-1 mb-4`}
                />
                <div className="flex gap-2 justify-end">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={saving}
                        className="px-3 py-1.5 text-sm rounded-md border border-[var(--border-default)] text-[var(--text-secondary)]"
                    >
                        {t('cms_site.site.pagelist.cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        disabled={!trimmed || saving}
                        onClick={async () => {
                            setSaving(true);
                            try { await onConfirm({ name: trimmed, description: description.trim() }); }
                            finally { setSaving(false); }
                        }}
                        className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent-primary)] text-white disabled:opacity-40"
                    >
                        {saving ? 'Saving…' : 'Save template'}
                    </button>
                </div>
            </div>
        </ModalShell>
    );
}

// ── Templates manager dialog ─────────────────────────────────────────

function TemplateItem({ tpl, confirming, onAskDelete, onConfirmDelete, onCancelDelete }: {
    tpl: PageTemplate;
    confirming: boolean;
    onAskDelete: () => void;
    onConfirmDelete: () => void;
    onCancelDelete: () => void;
}) {
    const { t } = useTranslation();
    return (
        <li className="py-2.5 flex items-start gap-3">
            <div className="flex-1 min-w-0">
                <div className="text-sm text-[var(--text-primary)] font-medium truncate">{tpl.name}</div>
                {tpl.description ? (
                    <div className="text-[11px] text-[var(--text-muted)] truncate">{tpl.description}</div>
                ) : null}
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                    {blockCountLabel(t, tpl.blockCount)}
                    {tpl.createdAt ? ` · ${formatTemplateDate(tpl.createdAt)}` : ''}
                </div>
            </div>
            {tpl.builtin ? null : confirming ? (
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        type="button"
                        onClick={onConfirmDelete}
                        className="px-2 py-1 text-[11px] rounded bg-red-500/90 text-white"
                    >
                        {t('cms_site.site.pagelist.delete', 'Delete')}
                    </button>
                    <button
                        type="button"
                        onClick={onCancelDelete}
                        className="px-2 py-1 text-[11px] rounded border border-[var(--border-default)] text-[var(--text-secondary)]"
                    >
                        {t('cms_site.site.pagelist.cancel', 'Cancel')}
                    </button>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={onAskDelete}
                    className="shrink-0 text-[var(--text-muted)] hover:text-red-400 p-1.5 rounded hover:bg-[var(--bg-tertiary)]"
                    title={t('cms_site.site.pagelist.delete_template', 'Delete template')}
                    aria-label={t('cms_site.site.pagelist.delete_template_named', 'Delete template "{name}"', { name: tpl.name })}
                >
                    <AppIcon name="Trash2" className="w-4 h-4" />
                </button>
            )}
        </li>
    );
}

interface TemplatesManagerDialogProps {
    templates: PageTemplate[];
    onDelete: (id: string) => Promise<unknown> | unknown;
    onClose: () => void;
}

export function TemplatesManagerDialog({ templates, onDelete, onClose }: TemplatesManagerDialogProps) {
    const { t } = useTranslation();
    // Inline confirm — clicking Delete reveals an inline "Confirm?" so
    // there's no second modal stacked on top of this one.
    const [confirmId, setConfirmId] = useState<string | null>(null);
    return (
        <ModalShell onClose={onClose} labelledBy="tpl-mgr-title">
            <div className="p-5">
                <div className="flex items-center justify-between mb-1">
                    <h3 id="tpl-mgr-title" className="text-sm font-semibold text-[var(--text-primary)]">
                        {t('cms_site.site.pagelist.templates', 'Templates')}
                    </h3>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded"
                        aria-label={t('cms_site.site.pagelist.close', 'Close')}
                    >
                        <AppIcon name="X" className="w-4 h-4" />
                    </button>
                </div>
                <p className="text-xs text-[var(--text-muted)] mb-4">
                    {t('cms_site.site.pagelist.templates_help', 'Saved page templates. Apply one when creating a new page.')}
                </p>
                {templates.length === 0 ? (
                    <p className="text-sm text-[var(--text-muted)] text-center py-6">
                        {t('cms_site.site.pagelist.templates_empty', 'No templates saved yet. Use a page\'s menu → "Save as template…" to create one.')}
                    </p>
                ) : (
                    <ul className="flex flex-col divide-y divide-[var(--border-subtle)]">
                        {templates.map(tpl => (
                            <TemplateItem
                                key={tpl.id}
                                tpl={tpl}
                                confirming={confirmId === tpl.id}
                                onAskDelete={() => setConfirmId(tpl.id)}
                                onConfirmDelete={async () => { await onDelete(tpl.id); setConfirmId(null); }}
                                onCancelDelete={() => setConfirmId(null)}
                            />
                        ))}
                    </ul>
                )}
            </div>
        </ModalShell>
    );
}
