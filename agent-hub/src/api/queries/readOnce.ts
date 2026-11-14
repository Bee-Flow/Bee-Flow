// The options of a read that replaced a fetch in a mount effect: asked when the
// component mounts (or its key changes), never again on focus or reconnect, and a
// failure is not retried. The screen shows the same requests and the same error
// state the effect gave it.

export const READ_ONCE = {
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
} as const;

/** A read whose answer depends on the HTTP status: the status and, on a 2xx, the parsed body. */
export interface StatusAnswer<T> {
    ok: boolean;
    status: number;
    data: T | null;
}

/** The status and (on a 2xx) the JSON body of a Response. */
export async function statusAnswer<T>(res: Response): Promise<StatusAnswer<T>> {
    return { ok: res.ok, status: res.status, data: res.ok ? (await res.json()) as T : null };
}
