import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const CaptureContext = createContext(null);

export function CaptureProvider({ children }) {
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState(null); // null = choose tile screen; 'record' | 'upload'
    // Every opening is a new capture session, numbered. A caller that files
    // the result somewhere (a project's meetings tab) keeps the number
    // openCapture returns, and takes a result only while no other opening
    // happened since: a capture started from anywhere else is not its to file.
    const sessionRef = useRef(0);
    const [session, setSession] = useState(0);

    const openCapture = useCallback((initialMode = null) => {
        sessionRef.current += 1;
        setSession(sessionRef.current);
        setMode(initialMode);
        setOpen(true);
        return sessionRef.current;
    }, []);

    const closeCapture = useCallback(() => {
        setOpen(false);
    }, []);

    const value = useMemo(() => ({
        open,
        mode,
        session,
        setMode,
        openCapture,
        closeCapture,
    }), [open, mode, session, openCapture, closeCapture]);

    return <CaptureContext.Provider value={value}>{children}</CaptureContext.Provider>;
}

export function useCapture() {
    const ctx = useContext(CaptureContext);
    if (!ctx) {
        return {
            open: false,
            mode: null,
            session: 0,
            setMode: () => {},
            openCapture: () => 0,
            closeCapture: () => {},
        };
    }
    return ctx;
}
