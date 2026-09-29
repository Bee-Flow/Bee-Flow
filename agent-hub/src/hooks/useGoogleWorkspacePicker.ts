// Shared state/API engine for the Google Workspace attachment pickers.
// Replaces the ~150-line block that was copy-pasted between GmailPicker
// and GoogleDrivePicker:
//
//   - connection status check against /api/integrations/<service>/status
//   - debounced search + pageToken pagination of a remote item list
//   - multi-select via a Set of item ids
//   - "attach": export each selected item and hand the results to chat
//   - OAuth connect popup that re-checks status once it closes
//
// Endpoints, the response array key, and the per-item export logic are
// passed via options so each picker stays a thin config wrapper (see
// GoogleWorkspacePickerModal.jsx for the matching UI shell).
//
// Usage:
//   const picker = useGoogleWorkspacePicker({
//       isOpen, onClose, onFilesSelected, apiBase,
//       statusPath: '/api/integrations/gmail/status',
//       listPath: '/api/integrations/gmail/messages',
//       listKey: 'messages',
//       loadErrorMessage: 'Failed to load messages',
//       exportItem: async (id, item) => ({ name, type, size, content, source }),
//   });

import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import useDebouncedValue from './useDebouncedValue';
import { openGoogleOAuthPopup } from '../lib/googleOAuthPopup';
import { API_BASE, authFetch } from '../utils/helpers';

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE = '20';

export interface WorkspaceConnectionStatus {
    connected: boolean;
    configured: boolean;
    user?: string | null;
}

/** A row in the remote list. Each picker knows its own extra fields. */
export interface WorkspaceItem {
    id: string;
    [key: string]: unknown;
}

/** One attachment handed to chat, as each picker's exportItem builds it. */
export type ExportedAttachment = Record<string, unknown>;

export interface UseGoogleWorkspacePickerOptions {
    isOpen: boolean;
    onClose: () => void;
    onFilesSelected: (files: ExportedAttachment[]) => void;
    apiBase?: string;
    statusPath: string;
    listPath: string;
    /** The key under which the list endpoint returns its array. */
    listKey: string;
    loadErrorMessage: string;
    exportItem: (id: string, item: WorkspaceItem | undefined) => Promise<ExportedAttachment>;
}

export interface UseGoogleWorkspacePickerReturn {
    status: WorkspaceConnectionStatus;
    items: WorkspaceItem[];
    loading: boolean;
    searchQuery: string;
    setSearchQuery: (q: string) => void;
    selectedIds: Set<string>;
    toggleItem: (itemId: string) => void;
    exporting: boolean;
    error: string | null;
    nextPageToken: string | null;
    loadMore: () => Promise<void>;
    handleAttach: () => Promise<void>;
    handleConnect: () => Promise<void>;
}

export default function useGoogleWorkspacePicker({
    isOpen,
    onClose,
    onFilesSelected,
    apiBase = '',
    statusPath,
    listPath,
    listKey,
    loadErrorMessage,
    exportItem,
}: UseGoogleWorkspacePickerOptions): UseGoogleWorkspacePickerReturn {
    const [status, setStatus] = useState<WorkspaceConnectionStatus>({ connected: false, configured: false, user: null });
    const [items, setItems] = useState<WorkspaceItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [nextPageToken, setNextPageToken] = useState<string | null>(null);

    const checkStatus = useCallback(async (): Promise<WorkspaceConnectionStatus> => {
        try {
            const res = await fetch(`${apiBase}${statusPath}`, { credentials: 'include' });
            const data = await res.json();
            setStatus(data);
            return data;
        } catch (err) {
            console.error('Google Workspace status check failed:', err);
            return { connected: false, configured: false };
        }
    }, [apiBase, statusPath]);

    const loadItems = useCallback(async (query = '', append = false) => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (query) params.set('query', query);
            if (append && nextPageToken) params.set('pageToken', nextPageToken);
            params.set('pageSize', PAGE_SIZE);

            const res = await fetch(`${apiBase}${listPath}?${params}`, { credentials: 'include' });
            if (!res.ok) {
                const err = await res.json();
                if (err.code === 'NOT_CONNECTED') {
                    setStatus(prev => ({ ...prev, connected: false }));
                    return;
                }
                throw new Error(err.error || loadErrorMessage);
            }
            const data = await res.json();
            setItems(prev => append ? [...prev, ...data[listKey]] : data[listKey]);
            setNextPageToken(data.nextPageToken);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [apiBase, listPath, listKey, loadErrorMessage, nextPageToken]);

    // On open: refresh connection status, load the first page, reset selection.
    // Effect Events, so neither effect re-fires when nextPageToken recreates loadItems.
    const onOpen = useEffectEvent(() => {
        checkStatus().then(s => {
            if (s.connected) loadItems();
        });
        setSelectedIds(new Set());
        setSearchQuery('');
    });
    useEffect(() => {
        if (isOpen) onOpen();
    }, [isOpen]);

    // Debounced remote search.
    const debouncedQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);
    const search = useEffectEvent((query: string) => {
        if (status.connected && isOpen) loadItems(query);
    });
    useEffect(() => {
        search(debouncedQuery);
    }, [debouncedQuery, status.connected]);

    const toggleItem = useCallback((itemId: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(itemId)) next.delete(itemId);
            else next.add(itemId);
            return next;
        });
    }, []);

    const loadMore = useCallback(() => loadItems(searchQuery, true), [loadItems, searchQuery]);

    const handleAttach = useCallback(async () => {
        if (selectedIds.size === 0) return;
        setExporting(true);
        setError(null);

        try {
            const results: ExportedAttachment[] = [];
            for (const itemId of selectedIds) {
                const item = items.find(i => i.id === itemId);
                results.push(await exportItem(itemId, item));
            }
            onFilesSelected(results);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setExporting(false);
        }
    }, [selectedIds, items, exportItem, onFilesSelected, onClose]);

    const handleConnect = useCallback(async () => {
        // BFSF-255: use the Google Workspace CONNECT flow, not the SSO LOGIN
        // flow. /auth/login/google replaces the whole session and — for a
        // password account whose email is not a Google account — silently
        // creates a NEW user. The connector flow authorises Google for the
        // CURRENT account and stores tokens in the encrypted vault.
        //
        // The popup itself is lib/googleOAuthPopup's job — the same helper the
        // Settings tile and the Meeting Notes surfaces use. This used to be an
        // inline window.open + close-poll, which had none of the helper's three
        // guarantees: a blocked popup (window.open returns null, it does not
        // throw) left a 500ms interval polling `null?.closed` for the life of
        // the tab and gave the user no feedback at all; there was no listener
        // for the callback page's postMessage, so the flow only finished when
        // the popup happened to be closed; and nothing checked the message's
        // origin. Duplicating the guard here would have been a second copy of
        // the same flow, so this now calls the shared one.
        setError(null);
        try {
            await openGoogleOAuthPopup({
                authFetch,
                apiBase: apiBase || API_BASE,
                // Fires both on the callback message and when the user closes
                // the popup — re-check either way, exactly as the old
                // close-poll did.
                onDone: () => {
                    checkStatus().then(s => {
                        if (s.connected) loadItems();
                    });
                },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[GoogleWorkspacePicker] connect failed:', message);
            setError(message || 'Could not start the Google connection. Try again.');
        }
    }, [apiBase, checkStatus, loadItems]);

    return {
        status,
        items,
        loading,
        searchQuery,
        setSearchQuery,
        selectedIds,
        toggleItem,
        exporting,
        error,
        nextPageToken,
        loadMore,
        handleAttach,
        handleConnect,
    };
}
