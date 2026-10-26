import { useCallback, useMemo, useState } from 'react';

/**
 * A form that starts from what the server holds and lets the person change it.
 * `value` is the server's values with the unsaved edits laid over them, so the
 * form never copies server data into its own state: when a new answer arrives
 * the fields the person did not touch follow it, and `discard()` (after a save
 * that re-reads the server) drops the edits.
 */
export default function useDraftOverServer<T extends object>(server: T) {
    const [edits, setEdits] = useState<Partial<T>>({});
    const value = useMemo(() => ({ ...server, ...edits }), [server, edits]);
    const patch = useCallback((change: Partial<T>) => setEdits(prev => ({ ...prev, ...change })), []);
    const discard = useCallback(() => setEdits({}), []);
    return { value, patch, discard };
}
