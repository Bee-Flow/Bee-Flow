import { useOptionalNavigation } from './NavigationContext';
import { useOptionalSession } from './SessionContext';
import type { NavigateToPage } from './useNavigateToPage';

type Navigate = (page: string, ...rest: never[]) => void;

/**
 * A component's `user` and `onNavigate`, from its props when a host hands
 * them (a test, a kit, an embed) and from the app shell's contexts otherwise.
 * The one line a component needs so the components between it and the shell
 * stop carrying the two as props. The session's user is the whole signed-in
 * person, so it is read in the shape the component declares for its prop.
 */
export function useShellProps<U, N extends Navigate>({ user, onNavigate }: { user?: U | null; onNavigate?: N | null }): {
    user: U | null;
    onNavigate: N | NavigateToPage | undefined;
} {
    const session = useOptionalSession();
    const navigation = useOptionalNavigation();
    return { user: user ?? (session?.user as U | null | undefined) ?? null, onNavigate: onNavigate ?? navigation?.navigateToPage };
}
