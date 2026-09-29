/**
 * AttachmentTray — the strip of files riding along with the next message.
 *
 * It sits directly on top of the composer box and shares its top corners with
 * whatever is above it: a thread banner already rounds them, so the tray
 * squares off rather than stacking two rounded lids on one another. That is
 * what `hasThreadBanner` decides, and it is the only layout knowledge this
 * component is given.
 *
 * Two shapes, because an image and a spreadsheet are read differently. An
 * image shows itself — a thumbnail with its name on a hover overlay, since the
 * picture is the identification and the filename rarely is. Everything else
 * gets a pill: an icon for the family it belongs to, its name, and its size,
 * because for a .docx the name IS the only identification there is.
 *
 * Removal is the caller's business (the composer owns the list); the tray only
 * says which index the person clicked.
 */
import { File as FileIcon, FileSpreadsheet, FileText, Image, X } from 'lucide-react';
import React from 'react';

import useTranslation from '../../../hooks/useTranslation';

import { formatFileSize } from './attachmentFiles';

/** The family an attachment belongs to, as a glyph. */
const getFileIcon = (type) => {
    if (type.startsWith('image/')) return <Image className="w-4 h-4" />;
    if (type.includes('pdf') || type.includes('word') || type.includes('.document')) return <FileText className="w-4 h-4" />;
    if (type.includes('spreadsheet') || type.includes('excel') || type.includes('csv')) return <FileSpreadsheet className="w-4 h-4" />;
    return <FileIcon className="w-4 h-4" />;
};

const AttachmentTray = ({ attachments, onRemove, hasThreadBanner }) => {
    const { t } = useTranslation();
    if (attachments.length === 0) return null;

    return (
        <div className={`flex flex-wrap gap-2 bg-[var(--bg-secondary)] px-3 py-2.5 border-x border-t border-[var(--border-subtle)] ${hasThreadBanner ? '' : 'rounded-t-xl'}`}>
            {attachments.map((att, idx) =>
                att.type.startsWith('image/') ? (
                    // Image attachment — card with thumbnail + overlaid remove button
                    <div
                        key={idx}
                        className="relative group flex-shrink-0"
                    >
                        <img
                            src={att.content}
                            alt={att.name}
                            className="w-16 h-16 object-cover rounded-xl border border-[var(--border-subtle)] shadow-sm"
                        />
                        {/* Filename overlay at bottom */}
                        <div className="absolute bottom-0 left-0 right-0 bg-black/50 rounded-b-xl px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <span className="text-white text-[9px] truncate block">{att.name}</span>
                        </div>
                        {/* Remove button — top-right corner */}
                        <button
                            onClick={() => onRemove(idx)}
                            className="absolute -top-1.5 -right-1.5 bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-full p-0.5 shadow-md opacity-0 group-hover:opacity-100 transition-all hover:bg-red-50 hover:border-red-300 hover:text-red-500 text-[var(--text-tertiary)]"
                            aria-label={t('chat.composer.remove_attachment', 'Remove attachment')}
                        >
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                ) : (
                    // Non-image attachment — refined pill
                    <div
                        key={idx}
                        className="flex items-center gap-2 bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] hover:border-[var(--border-default)] px-2.5 py-2 rounded-xl text-xs text-[var(--text-secondary)] transition-colors group"
                    >
                        <div className="text-[var(--text-tertiary)]">{getFileIcon(att.type)}</div>
                        <div className="flex flex-col min-w-0">
                            <span className="truncate max-w-[120px] font-medium text-[var(--text-primary)]">{att.name}</span>
                            <span className="text-[10px] text-[var(--text-tertiary)]">{formatFileSize(att.size)}</span>
                        </div>
                        <button
                            onClick={() => onRemove(idx)}
                            className="p-0.5 ml-0.5 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)] hover:text-red-500 transition-colors"
                            aria-label={t('chat.composer.remove_attachment', 'Remove attachment')}
                        >
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                )
            )}
        </div>
    );
};

export default AttachmentTray;
