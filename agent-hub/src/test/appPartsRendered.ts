// The part classes (`bfa-<type>__<part>`) a render carries, against the parts the type declares in the catalogue.
import snapshot from '@/components/admin/Studio/AppStudio/runtime/catalogSnapshot.generated.json';

/** The parts of `type` found in the markup of the given containers (their union). */
export function renderedParts(type: string, ...containers: Element[]): string[] {
    const found = new Set<string>();
    for (const container of containers) {
        for (const el of container.querySelectorAll('[class]')) {
            for (const token of Array.from(el.classList)) {
                if (token.startsWith(`bfa-${type}__`)) found.add(token.slice(`bfa-${type}__`.length));
            }
        }
    }
    return [...found].sort();
}

/** The parts the catalogue declares for `type`, sorted. */
export function declaredParts(type: string): string[] {
    const spec = Reflect.get(snapshot.types, type) as { parts?: string[] } | undefined;
    return [...(spec?.parts ?? [])].sort();
}
