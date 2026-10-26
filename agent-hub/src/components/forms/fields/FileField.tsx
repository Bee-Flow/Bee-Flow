import React, { useState } from 'react';
import { Loader2, Paperclip, X } from 'lucide-react';
import { messageOf } from '@/utils/caughtError';
import type { FileFieldProps } from '../PublicFormRenderer.types';


/**
 * A file field uploads immediately and keeps only the DESCRIPTOR. Bytes never
 * travel with the submission, so a large attachment can't blow the body limit
 * and a failed submit doesn't mean re-picking the file.
 */
export default function FileField({ field, value, disabled, onChange, onUpload, onError }: FileFieldProps) {
    const [uploading, setUploading] = useState(false);

    const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        // Let the same file be picked again after a failure.
        e.target.value = '';
        if (!file || !onUpload) return;
        if (file.size > (field.maxSizeMb as number) * 1024 * 1024) {
            onError(`That file is larger than ${field.maxSizeMb} MB.`);
            return;
        }
        setUploading(true);
        try {
            const uploaded = await onUpload(file, field.name);
            onChange({ kind: 'form_upload', fileId: uploaded.fileId, filename: uploaded.filename, size: uploaded.size });
        } catch (err) {
            onError(messageOf(err, 'That file could not be uploaded.'));
        } finally {
            setUploading(false);
        }
    };

    if (value) {
        return (
            <div
                className="flex items-center gap-2 px-2.5 py-1.5 text-sm border [border-color:var(--border-default)] [border-radius:var(--app-radius)] [color:var(--text-primary)]!"
            >
                <Paperclip size={14} className="[color:var(--app-primary)]" />
                <span className="truncate flex-1 min-w-0">{value.filename}</span>
                <button
                    type="button"
                    onClick={() => onChange(null)}
                    disabled={disabled}
                    aria-label={`Remove ${value.filename}`}
                    className="text-[var(--text-secondary)]"
                >
                    <X size={14} />
                </button>
            </div>
        );
    }

    return (
        <label
            className="flex items-center gap-2 px-2.5 py-1.5 text-sm border cursor-pointer [border-color:var(--border-default)] [border-radius:var(--app-radius)] [color:var(--text-secondary)]!"
        >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
            <span>{uploading ? 'Uploading…' : `Choose a file (max ${field.maxSizeMb} MB)`}</span>
            <input
                type="file"
                className="sr-only"
                accept={field.accept || undefined}
                disabled={disabled || uploading}
                onChange={pick}
            />
        </label>
    );
}
