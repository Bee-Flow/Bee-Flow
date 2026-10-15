interface StatGridProps {
    children?: React.ReactNode;
    testId?: string;
}

/** A row of StatTiles: two up on a phone, four up from a tablet. */
export default function StatGrid({ children, testId }: StatGridProps) {
    return <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid={testId}>{children}</div>;
}
