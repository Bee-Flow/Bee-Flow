import { lazy, Suspense } from 'react';
import type { AppDefinition } from '../inspector/appDefinition';

// Editor only and schema 3: loaded when the Logic tab shows it, never with the app's run bundle.
const ServerTriggersPanel = lazy(() => import('./ServerTriggersPanel'));

/** The server triggers of the app in the Logic tab, once there is an app and a definition to edit. */
export default function ServerTriggersSlot({ app, definition, onCommit, disabled = false }: {
    app: { id: string } | null | undefined;
    definition: AppDefinition | null | undefined;
    onCommit?: (definition: AppDefinition) => void;
    disabled?: boolean;
}) {
    if (!app?.id || !definition || typeof onCommit !== 'function') return null;
    return (
        <Suspense fallback={null}>
            <ServerTriggersPanel appId={app.id} definition={definition} onCommit={onCommit} disabled={disabled} />
        </Suspense>
    );
}
