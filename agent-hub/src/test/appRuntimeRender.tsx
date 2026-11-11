// Render an App Studio runtime component inside a RuntimeProvider, as the runtime tests do.
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '@/components/admin/Studio/AppStudio/runtime/RuntimeContext';
import type { RuntimeValue } from '@/components/admin/Studio/AppStudio/runtime/RuntimeContext';

/** `ui` in the library runtime with a scope fixed at 2026-01-01, and `overrides` on top. */
export function renderInRuntime(ui: ReactElement, overrides: Partial<RuntimeValue> = {}) {
    const value: RuntimeValue = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }), ...overrides };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}
