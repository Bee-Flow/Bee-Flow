import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { toast } from '@/components/shared/Toast';
import { imageLimitsToInput, parseImageLimitsInput } from '@/utils/imageLimits';
import type { ImageLimits, ImageLimitsInput } from '@/utils/imageLimits';
import ImageLimitsField from './ImageLimitsField';

interface ImageLimitsEditorProps {
    /** The stored limits; null/undefined = none set. */
    value: ImageLimits | null | undefined;
    label: string;
    hint?: string;
    /** Store the limits; true when the server took them. */
    onSave: (limits: ImageLimits | null) => Promise<boolean>;
}

/**
 * The image limits of one group or member with their own Save, for the
 * organisation panel where every setting saves by itself. The inputs show the
 * stored value until something is typed; Save and Cancel appear then.
 */
export default function ImageLimitsEditor({ value, label, hint, onSave }: ImageLimitsEditorProps) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<ImageLimitsInput | null>(null);
    const [saving, setSaving] = useState(false);
    const shown = draft ?? imageLimitsToInput(value);

    const save = async () => {
        if (!draft) return;
        const parsed = parseImageLimitsInput(draft);
        if (parsed === undefined) {
            toast.error(t('image_limits.invalid', 'An image limit is a whole number from 0 to 1,000,000, or empty.'));
            return;
        }
        setSaving(true);
        try {
            if (await onSave(parsed)) setDraft(null);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div>
            <ImageLimitsField compact value={shown} onChange={setDraft} label={label} hint={hint} />
            {draft && (
                <div className="flex items-center gap-2 mt-2">
                    <button
                        type="button"
                        onClick={() => void save()}
                        disabled={saving}
                        className="px-3 py-1 rounded-lg text-xs font-medium bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-50"
                    >
                        {saving ? '...' : t('image_limits.save', 'Save image limits')}
                    </button>
                    <button type="button" onClick={() => setDraft(null)} className="px-3 py-1 rounded-lg text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]">
                        {t('image_limits.cancel', 'Cancel')}
                    </button>
                </div>
            )}
        </div>
    );
}
