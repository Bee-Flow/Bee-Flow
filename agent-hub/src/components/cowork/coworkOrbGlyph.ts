// Sample both the outline and changes of colour inside a mark. This retains
// details such as an envelope drawn on an opaque, single-colour app tile.
export interface NeuralGlyph { nodes: Path2D; links: Path2D; sparks: { x: number; y: number }[] }
const SIZE = 40;

export function sampleMark(data: Uint8ClampedArray) {
    const dots: { x: number; y: number }[] = [];
    for (let y = 1; y < SIZE - 1; y += 2) {
        for (let x = 1; x < SIZE - 1; x += 2) {
            const i = 4 * (y * SIZE + x);
            if (data[i + 3] < 45) continue;
            const edge = [-8, 8, -4 * SIZE, 4 * SIZE].some(offset =>
                [0, 1, 2, 3].some(channel => Math.abs(data[i + channel] - (data[i + offset + channel] ?? 0)) > 38));
            if (edge || (x + 3 * y) % 10 === 0) dots.push({ x: x + .37 * Math.sin(x * 17 + y * 7), y: y + .37 * Math.sin(y * 11 - x * 5) });
        }
    }
    return dots;
}

function network(data: Uint8ClampedArray): NeuralGlyph {
    const dots = sampleMark(data);
    const nodes = new Path2D(), links = new Path2D();
    for (const [i, p] of dots.entries()) {
        nodes.moveTo(p.x + .64, p.y);
        nodes.arc(p.x, p.y, .64, 0, Math.PI * 2);
        for (let j = i - 1; j >= 0 && p.y - dots[j].y <= 3; j--) {
            const q = dots[j];
            if (Math.hypot(p.x - q.x, p.y - q.y) > 3.2) continue;
            links.moveTo(p.x, p.y);
            links.lineTo(q.x, q.y);
        }
    }
    return { nodes, links, sparks: dots.filter((_, i) => i % 13 === 0) };
}

async function drawSource(ctx: CanvasRenderingContext2D, element: Element) {
    const svg = element.querySelector('svg');
    const img = element.querySelector('img');
    if (!svg && !img) {
        ctx.font = 'bold 30px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(element.textContent?.trim() || '·', 20, 20, 36);
        return;
    }
    const image = new Image();
    image.crossOrigin = 'anonymous';
    if (svg) {
        const copy = svg.cloneNode(true) as SVGSVGElement;
        copy.setAttribute('width', '40');
        copy.setAttribute('height', '40');
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
    } else image.src = img!.currentSrc || img!.src;
    await image.decode();
    ctx.drawImage(image, 2, 2, 36, 36);
}

export async function readOrbGlyph(element: Element): Promise<NeuralGlyph | null> {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    try {
        await drawSource(ctx, element);
        return network(ctx.getImageData(0, 0, SIZE, SIZE).data);
    } catch {
        // A remote icon can disallow pixel reads. Leave its place to the existing neural field.
        return null;
    }
}
