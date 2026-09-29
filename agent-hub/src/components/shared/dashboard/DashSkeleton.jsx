/** What a dashboard looks like before its first answer: tiles, then cards. */
export default function DashSkeleton({ tiles = 4, cards = 3, testId }) {
    const block = (key, h) => (
        <div key={key} className="rounded-xl animate-pulse" style={{ background: 'var(--bg-secondary)', height: h }} />
    );
    return (
        <div className="space-y-4" role="status" aria-busy="true" data-testid={testId}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {Array.from({ length: tiles }, (_, i) => block(`t${i}`, 84))}
            </div>
            {Array.from({ length: cards }, (_, i) => block(`c${i}`, 140))}
        </div>
    );
}
