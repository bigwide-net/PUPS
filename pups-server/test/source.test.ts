import fs from 'fs';
import path from 'path';

// Control, invisible (bidi, zero-width) and specials characters, built at runtime so that this
// file contains none. Source code must spell them as escapes ("Trojan Source", CVE-2021-42574).
const RANGES = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x200b, 0x200b], [0x200e, 0x200f],
    [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff], [0xfff0, 0xffff]];
const isUnsafe = (c: number) => RANGES.some(([a, b]) => c >= a && c <= b);

function* sourceFiles(dir: string): Generator<string> {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'data', 'certs', '.git'].includes(e.name))
            continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory())
            yield* sourceFiles(p);
        else if (/\.(ts|js|json|md|sh)$|^\.env\.example$/.test(e.name))
            yield p;
    }
}

describe('source files', () => {
    it('contain no literal control or invisible characters', () => {
        const root = path.join(__dirname, '..');
        const found: string[] = [];
        for (const file of sourceFiles(root)) {
            const text = fs.readFileSync(file, 'utf8');
            text.split('\n').forEach((line, i) => {
                for (const ch of line)
                    if (isUnsafe(ch.codePointAt(0)!) && ch != '\t' && ch != '\r')
                        found.push(`${path.relative(root, file)}:${i + 1}: U+${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`);
            });
        }
        expect(found).toEqual([]);
    });
});
