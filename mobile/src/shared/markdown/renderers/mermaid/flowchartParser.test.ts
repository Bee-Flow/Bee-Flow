import { cleanLabel, readNode } from './flowchartNodes';
import { readFlowchart, statements } from './flowchartParser';

describe('readNode', () => {
    it.each([
        ['A', { id: 'A', label: null, shape: null }],
        ['A[Start here]', { id: 'A', label: 'Start here', shape: 'rect' }],
        ['B(Round)', { id: 'B', label: 'Round', shape: 'round' }],
        ['C([Stadium])', { id: 'C', label: 'Stadium', shape: 'stadium' }],
        ['D[[Sub]]', { id: 'D', label: 'Sub', shape: 'subroutine' }],
        ['E[(Database)]', { id: 'E', label: 'Database', shape: 'cylinder' }],
        ['F((Circle))', { id: 'F', label: 'Circle', shape: 'circle' }],
        ['G(((Double)))', { id: 'G', label: 'Double', shape: 'doublecircle' }],
        ['H>Flag]', { id: 'H', label: 'Flag', shape: 'asymmetric' }],
        ['I{Decide?}', { id: 'I', label: 'Decide?', shape: 'rhombus' }],
        ['J{{Hex}}', { id: 'J', label: 'Hex', shape: 'hexagon' }],
        ['K[/In/]', { id: 'K', label: 'In', shape: 'parallelogram' }],
        ['L[\\Out\\]', { id: 'L', label: 'Out', shape: 'parallelogram-alt' }],
        ['M[/Trap\\]', { id: 'M', label: 'Trap', shape: 'trapezoid' }],
        ['N["Quoted (with) [brackets]"]', { id: 'N', label: 'Quoted (with) [brackets]', shape: 'rect' }],
        ['O[One<br/>Two]:::hot', { id: 'O', label: 'One\nTwo', shape: 'rect' }],
    ])('%s', (src, expected) => {
        expect(readNode(src)).toMatchObject(expected);
    });

    it('stops at the reference', () => {
        expect(readNode('A[x] --> B')?.length).toBe(4);
        expect(readNode('--> B')).toBeNull();
    });

    it('cleans Mermaid entities and icons out of labels', () => {
        expect(cleanLabel('"say #quot;hi#quot; fa:fa-car "')).toBe('say "hi"');
    });
});

describe('statements', () => {
    it('splits lines and semicolons, but not inside labels', () => {
        expect(statements('graph TD;A-->B;B["x;y"]-->C\n%% note\n  C --> D  ')).toEqual([
            'graph TD',
            'A-->B',
            'B["x;y"]-->C',
            'C --> D',
        ]);
    });
});

describe('readFlowchart', () => {
    it('reads direction, nodes, labelled links and chains', () => {
        const chart = readFlowchart(
            ['flowchart LR', '  A[Start] --> B{Ok?}', '  B -->|yes| C(Done)', '  B -- no --> D', '  C --> E --> F'].join('\n'),
        );
        expect(chart?.direction).toBe('LR');
        expect(chart?.nodes.map((n) => n.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
        expect(chart?.nodes.find((n) => n.id === 'B')).toMatchObject({ label: 'Ok?', shape: 'rhombus' });
        expect(chart?.edges.map((e) => [e.from, e.to, e.label])).toEqual([
            ['A', 'B', ''],
            ['B', 'C', 'yes'],
            ['B', 'D', 'no'],
            ['C', 'E', ''],
            ['E', 'F', ''],
        ]);
    });

    it('reads link styles and ends', () => {
        const chart = readFlowchart('graph TD\nA -.-> B\nB ==> C\nC --- D\nD <--> E\nE --o F\nF --x G\nG ~~~ H\nH -. maybe .-> I');
        expect(chart?.edges.map((e) => [e.line, e.start, e.end])).toEqual([
            ['dotted', 'none', 'arrow'],
            ['thick', 'none', 'arrow'],
            ['solid', 'none', 'none'],
            ['solid', 'arrow', 'arrow'],
            ['solid', 'none', 'circle'],
            ['solid', 'none', 'cross'],
            ['invisible', 'none', 'none'],
            ['dotted', 'none', 'arrow'],
        ]);
        expect(chart?.edges[7]?.label).toBe('maybe');
    });

    it('fans out and in with &', () => {
        const chart = readFlowchart('graph TD\nA & B --> C & D');
        expect(chart?.edges.map((e) => `${e.from}${e.to}`)).toEqual(['AC', 'AD', 'BC', 'BD']);
    });

    it('groups nodes into subgraphs, nested, and skips styling', () => {
        const chart = readFlowchart(
            [
                'graph TB',
                'subgraph one [First group]',
                '  a1 --> a2',
                '  subgraph inner',
                '    i1',
                '  end',
                'end',
                'classDef hot fill:#f00',
                'style a1 fill:#fff',
                'a2 --> i1',
            ].join('\n'),
        );
        expect(chart?.groups).toEqual([
            { id: 'one', title: 'First group', nodes: ['a1', 'a2'], parent: null },
            { id: 'inner', title: 'inner', nodes: ['i1'], parent: 'one' },
        ]);
        expect(chart?.edges).toHaveLength(2);
    });

    it('is not a flowchart: other diagram kinds, or nothing to draw', () => {
        expect(readFlowchart('sequenceDiagram\nA->>B: hi')).toBeNull();
        expect(readFlowchart('pie title Pets\n"Dogs": 3')).toBeNull();
        expect(readFlowchart('graph TD\n')).toBeNull();
    });

    it('skips a statement it cannot read and keeps the rest', () => {
        const chart = readFlowchart('graph TD\nA --> B\n??? nonsense\nB --> C');
        expect(chart?.edges.map((e) => `${e.from}${e.to}`)).toEqual(['AB', 'BC']);
    });

    it('ignores an init directive', () => {
        expect(readFlowchart('%%{init: {"theme": "dark"}}%%\ngraph LR\nA-->B')?.direction).toBe('LR');
    });
});
