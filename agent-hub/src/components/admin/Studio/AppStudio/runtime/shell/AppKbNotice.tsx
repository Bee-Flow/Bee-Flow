import { useMemo } from 'react';
import KbQueryLogNotice from '@/components/chat/KbQueryLogNotice';
import { appKbIds } from './appKbIds';

/** The query-log notice at the top of an app that reads knowledge bases; nothing (and no request) when it reads none. */
export default function AppKbNotice({ definition }: { definition: unknown }) {
    const ids = useMemo(() => appKbIds(definition), [definition]);
    if (ids.length === 0) return null;
    return <KbQueryLogNotice kbIds={ids} className="px-3 py-1.5" />;
}
