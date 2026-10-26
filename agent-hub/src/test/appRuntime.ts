// Typed builders for the App Studio runtime context.
import { DEFAULT_RUNTIME, type RuntimeValue } from '@/components/admin/Studio/AppStudio/runtime/RuntimeContext';

/** A complete RuntimeValue: the library defaults with what the test cares about on top. */
export function runtimeValue(overrides: Partial<RuntimeValue> = {}): RuntimeValue {
    return { ...DEFAULT_RUNTIME, ...overrides };
}
