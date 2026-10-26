import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { languagesKey, useLanguagesQuery, type LanguagesAnswer } from '@/api/queries/adminConfigReads';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { LANGUAGES_API, getLanguages, sendLanguages, sendLanguagesJson } from '@/api/languages';
import useConfirm from '../../shared/useConfirm';

export { LANGUAGES_API };

/** One installed locale. */
interface LocaleEntry {
    code: string;
    name: string;
    isDefault?: boolean;
}

/** One locale that can be added (the server's catalogue). */
export interface CatalogEntry {
    code: string;
    name: string;
}

export interface LanguagesState {
    locales: LocaleEntry[];
    catalog: CatalogEntry[];
    selectedLocale: string | null;
    setSelectedLocale: Dispatch<SetStateAction<string | null>>;
    loading: boolean;
    error: string;
    setError: Dispatch<SetStateAction<string>>;
    showAddModal: boolean;
    setShowAddModal: Dispatch<SetStateAction<boolean>>;
    handleAddLocale: (code: string, name: string) => Promise<void>;
    handleDeleteLocale: (code: string) => Promise<void>;
    handleExport: (code: string) => Promise<void>;
    handleImport: (code: string) => void;
    handleSetDefault: (code: string) => Promise<void>;
    confirmDialog: ReactNode;
}

/** Download the locale's whole dictionary as a JSON file. */
async function downloadExport(code: string) {
    const res = await getLanguages(`${code}/export`);
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `beeflow-i18n-${code}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

const NO_LOCALES: LocaleEntry[] = [];
const NO_CATALOG: CatalogEntry[] = [];

/** The installed locales, the catalogue, the selection and every locale-level action. */
export default function useLanguages(): LanguagesState {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const languages = useLanguagesQuery<LocaleEntry, CatalogEntry>();
    const locales = languages.data?.locales ?? NO_LOCALES;
    const catalog = languages.data?.catalog ?? NO_CATALOG;
    // The locale list the server returns after a write replaces the cached one.
    const setLocales = useCallback((next: LocaleEntry[]) => {
        queryClient.setQueryData<LanguagesAnswer<LocaleEntry, CatalogEntry>>(languagesKey, (prev) => ({ catalog: prev?.catalog ?? NO_CATALOG, locales: next }));
    }, [queryClient]);
    // Until one is chosen, the first non-English locale (or English) is selected.
    const [chosenLocale, setSelectedLocale] = useState<string | null>(null);
    const selectedLocale = chosenLocale || locales.find(l => l.code !== 'en')?.code || locales[0]?.code || null;
    const [actionError, setError] = useState('');
    const error = actionError || (languages.isError ? t('admin_languages.error_load', 'Failed to load languages') : '');
    const loading = languages.isPending;
    const [showAddModal, setShowAddModal] = useState(false);
    const { confirm, confirmDialog } = useConfirm();
    const { refetch: fetchLocales } = languages;

    const handleAddLocale = async (code: string, name: string) => {
        try {
            const res = await sendLanguagesJson('POST', '', { code, name });
            const data = await res.json();
            if (data.success) {
                setLocales(data.locales);
                setSelectedLocale(code);
                setShowAddModal(false);
            } else {
                setError(data.error || t('admin_languages.error_add', 'Failed to add language'));
            }
        } catch { setError(t('admin_languages.error_add', 'Failed to add language')); }
    };

    const handleDeleteLocale = async (code: string) => {
        if (!(await confirm({ title: t('admin_languages.confirm_delete', 'Delete "{code}" and all its translations?', { code }), confirmLabel: t('admin_languages.delete', 'Delete'), destructive: true }))) return;
        try {
            const res = await sendLanguages('DELETE', code);
            const data = await res.json();
            if (data.success) {
                setLocales(data.locales);
                if (selectedLocale === code) {
                    setSelectedLocale(data.locales[0]?.code || null);
                }
            }
        } catch { setError(t('admin_languages.error_delete', 'Failed to delete language')); }
    };

    const handleExport = async (code: string) => {
        try {
            await downloadExport(code);
        } catch { setError(t('admin_languages.error_export', 'Export failed')); }
    };

    const handleImport = (code: string) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const res = await sendLanguagesJson('POST', `${code}/import`, data);
                if (res.ok) fetchLocales();
            } catch { setError(t('admin_languages.error_import', 'Import failed: invalid JSON file')); }
        };
        input.click();
    };

    const handleSetDefault = async (code: string) => {
        try {
            const res = await sendLanguages('PUT', `${code}/default`);
            const data = await res.json();
            if (data.success) setLocales(data.locales);
        } catch { setError(t('admin_languages.error_set_default', 'Failed to set default')); }
    };

    return {
        locales, catalog, selectedLocale, setSelectedLocale, loading, error, setError,
        showAddModal, setShowAddModal,
        handleAddLocale, handleDeleteLocale, handleExport, handleImport, handleSetDefault, confirmDialog,
    };
}
