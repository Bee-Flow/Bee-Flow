/**
 * Types for the one-icon modules registry.generated.ts imports.
 *
 * lucide-react-native's `exports` lists only its barrel (all ~1,670 icons,
 * which Metro would bundle whole), so TypeScript cannot resolve a single
 * icon's file on its own. Each of those files default-exports one icon
 * component; metro.config.js and jest.config.js resolve the paths.
 */
declare module 'lucide-react-native/dist/esm/icons/*' {
    import type { LucideIcon } from 'lucide-react-native';

    const icon: LucideIcon;
    export default icon;
}
