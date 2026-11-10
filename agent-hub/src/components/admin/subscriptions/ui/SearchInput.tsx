import { Search, X } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { INPUT } from '@/components/mcpLibrary/ui';

interface SearchInputProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
    autoFocus?: boolean;
}

export function SearchInput({ value, onChange, placeholder, className = '', autoFocus = false }: SearchInputProps) {
    const { t } = useTranslation();
    return (
        <div className={`relative ${className}`}>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)] pointer-events-none" />
            <input
                type="text"
                value={value}
                placeholder={placeholder ?? t('admin_subscriptions.ui_search', 'Search…')}
                autoFocus={autoFocus}
                onChange={e => onChange(e.target.value)}
                className={`${INPUT} pl-9 pr-9`}
            />
            {value && (
                <button
                    type="button"
                    onClick={() => onChange('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 inline-flex items-center justify-center rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                    aria-label={t('admin_subscriptions.ui_clear_search', 'Clear search')}
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            )}
        </div>
    );
}
