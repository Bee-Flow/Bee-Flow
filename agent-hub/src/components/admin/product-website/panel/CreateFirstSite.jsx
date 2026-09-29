// The CMS panel's screen when the organisation has no sites yet: the shared
// placard, with the one thing to do here — naming the first site — inline.
import React, { useEffect, useRef, useState } from 'react';
import AppIcon from '../../../icons/AppIcon';
import EmptyState from '../../../shared/EmptyState';

export default function CreateFirstSite({ onCreate }) {
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const inputRef = useRef(null);

    useEffect(() => {
        if (creating) inputRef.current?.focus();
    }, [creating]);

    // Read the DOM value first: autofill and IME composition can change it
    // without an onChange, which once left this button disabled on a filled field.
    const submit = async () => {
        const fromRef = inputRef.current?.value ?? '';
        const value = (fromRef || name).trim();
        if (!value) return;
        await onCreate(value);
    };

    const cancel = () => { setCreating(false); setName(''); };

    const action = creating ? (
        <div className="w-full max-w-sm text-left">
            <label className="block text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">
                Site name
            </label>
            <input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Bakery"
                onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                    if (e.key === 'Escape') cancel();
                }}
                className="w-full px-3 py-2 rounded text-sm border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
            <div className="flex justify-end gap-2 mt-3">
                <button
                    type="button"
                    onClick={cancel}
                    className="text-sm px-3 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={submit}
                    className="text-sm px-3 py-1.5 rounded bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-primary)]/90"
                >
                    Create website
                </button>
            </div>
        </div>
    ) : (
        <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[var(--accent-primary)] text-white text-sm font-medium hover:bg-[var(--accent-primary)]/90"
        >
            <AppIcon name="Plus" className="w-4 h-4" />
            Create your first website
        </button>
    );

    return (
        <EmptyState
            icon={<AppIcon name="Globe" className="w-12 h-12 text-[var(--text-muted)]" />}
            title="No websites yet"
            description="Create your first website to start adding pages and blocks."
            action={action}
        />
    );
}
