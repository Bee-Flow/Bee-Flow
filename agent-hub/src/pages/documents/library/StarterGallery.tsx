// Starting a new document: a page to write in, a designed document (blank or
// from a starter with its parameters and sections), or a presentation.

import { FileText, NotebookPen, Plus, Presentation } from 'lucide-react';
import React from 'react';
import Modal from '../../../components/shared/Modal';
import useTranslation from '../../../hooks/useTranslation';
import { useStarters, type Starter } from '../documentQueries';

export type NewChoice = { type: 'page' } | { type: 'designed'; starter: Starter | null } | { type: 'deck'; starter: Starter | null };

export interface StarterGalleryProps {
    open: boolean;
    busy: boolean;
    error: string | null;
    onChoose: (choice: NewChoice) => void;
    onClose: () => void;
}

const TILE = 'flex flex-col items-start gap-1 p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-left hover:border-[var(--accent-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';

function Tile({ icon, title, hint, onClick, busy, testId }: { icon: React.ReactNode; title: string; hint?: string; onClick: () => void; busy: boolean; testId?: string }) {
    return (
        <button type="button" className={TILE} disabled={busy} onClick={onClick} data-testid={testId}>
            <span className="text-[var(--accent-primary)]" aria-hidden="true">{icon}</span>
            <strong className="text-sm text-[var(--text-primary)]">{title}</strong>
            {hint && <span className="text-xs text-[var(--text-tertiary)]">{hint}</span>}
        </button>
    );
}

export default function StarterGallery({ open, busy, error, onChoose, onClose }: StarterGalleryProps) {
    const { t, locale } = useTranslation();
    const starters = useStarters(locale || 'en', open);
    const list = starters.data || [];
    const params = (s: Starter) => t('documents.new.parameters', '{count} fields to fill in', { count: s.settings?.contract?.parameters?.length || 0 });
    return (
        <Modal open={open} onClose={onClose} title={t('documents.new.title', 'Start a document')} size="lg" disableEscapeClose={busy}>
            <div className="space-y-5" data-testid="document-gallery">
                {error && <p role="alert" className="text-[12px] text-[var(--error)]">{error}</p>}
                <section className="grid sm:grid-cols-2 gap-3">
                    <Tile icon={<NotebookPen size={20} />} title={t('documents.new.page', 'Page')} hint={t('documents.new.page_hint', 'Write freely, together in real time in a project. Prints with the house style.')} busy={busy} onClick={() => onChoose({ type: 'page' })} testId="documents-new-page" />
                    <Tile icon={<Plus size={20} />} title={t('documents.new.blank_designed', 'Blank designed document')} hint={t('documents.new.designed_hint', 'A laid-out document with fields a routine can fill.')} busy={busy} onClick={() => onChoose({ type: 'designed', starter: null })} />
                </section>
                <section>
                    <h3 className="text-sm font-semibold mb-2 text-[var(--text-primary)]">{t('documents.new.templates', 'From a template')}</h3>
                    {starters.isPending && <p className="text-xs text-[var(--text-tertiary)]" role="status">{t('documents.new.loading', 'Loading templates…')}</p>}
                    {starters.isError && <p className="text-xs text-[var(--error)]" role="alert">{t('documents.new.load_failed', 'The templates could not be loaded.')}</p>}
                    <div className="grid sm:grid-cols-2 gap-3">
                        {list.filter((s) => s.docType !== 'presentation').map((s) => (
                            <Tile key={s.id} icon={<FileText size={20} />} title={s.name} hint={params(s)} busy={busy} onClick={() => onChoose({ type: 'designed', starter: s })} />
                        ))}
                    </div>
                </section>
                <section>
                    <h3 className="text-sm font-semibold mb-1 text-[var(--text-primary)]">{t('documents.new.presentations', 'Presentations')}</h3>
                    <p className="text-xs mb-2 text-[var(--text-tertiary)]">{t('documents.new.presentations_hint', 'Slides in the house style: an outline you type, viewed here and downloaded as PowerPoint or PDF.')}</p>
                    <div className="grid sm:grid-cols-2 gap-3">
                        <Tile icon={<Plus size={20} />} title={t('documents.new.blank_deck', 'Blank presentation')} busy={busy} onClick={() => onChoose({ type: 'deck', starter: null })} testId="documents-new-presentation" />
                        {list.filter((s) => s.docType === 'presentation').map((s) => (
                            <Tile key={s.id} icon={<Presentation size={20} />} title={s.name} hint={params(s)} busy={busy} onClick={() => onChoose({ type: 'deck', starter: s })} />
                        ))}
                    </div>
                </section>
            </div>
        </Modal>
    );
}
