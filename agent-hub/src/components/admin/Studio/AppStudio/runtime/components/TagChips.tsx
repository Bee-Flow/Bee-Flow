import { asTags, Pill } from './cellValue';
import { displayValue } from '../uiBits';

/** True when `value` holds at least one tag. */
export function hasTags(value: unknown) {
    return value != null && value !== '' && asTags(value).length > 0;
}

/**
 * Small neutral chips for a tag-like value (an array, a JSON-array string or
 * comma-separated text), the same pills a `format: 'tags'` column draws. Used
 * by page_header.tagsFrom and list.tagsKey (mail categories, labels). Empty
 * or null shows nothing; `max` caps the visible chips and adds a "+N".
 */
export default function TagChips({ value, max = 0, className = '' }: { value: unknown; max?: number; className?: string }) {
    if (value == null || value === '') return null;
    const tags = asTags(value);
    if (!tags.length) return null;
    const shown = max > 0 ? tags.slice(0, max) : tags;
    const rest = tags.length - shown.length;
    return (
        <span className={`inline-flex flex-wrap items-center gap-1 ${className}`} data-app-tags="true">
            {shown.map((tag, i) => (
                <Pill key={i}>{displayValue(tag)}</Pill>
            ))}
            {rest > 0 ? <Pill>{`+${rest}`}</Pill> : null}
        </span>
    );
}
