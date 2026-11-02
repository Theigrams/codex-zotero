import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The MuPDF glyph repair (native/text_layer.py) on a generated PDF like the 3B2/Advent ones in older Elsevier
// papers: Type 1C fonts with a built-in encoding, no ToUnicode, and glyphs named only by a number (C101 = "e").
// Needs the Python with PyMuPDF and fontTools that install.mjs would use; skipped without it.
function python() {
  try {
    return execFileSync(process.env.CODEX_ZOTERO_PYTHON || 'python3', ['-c', 'import sys, pymupdf, fontTools; print(sys.executable)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Three fonts: body text whose codes equal the numbers in its glyph names; a heading font whose codes do not
// ("gywi…" draws C67 C79 C77 P…, as in the real papers, where PDFKit shows the codes); a symbol font named the
// same way, whose numbers are not letters (the real one draws © as C113, "q").
const MAKE = String.raw`
import io, sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen

def cff(name, encoding):
    glyphs = ['.notdef'] + sorted(set(encoding.values()))
    fb = FontBuilder(1000, isTTF=False)
    fb.setupGlyphOrder(glyphs)
    fb.setupCharacterMap({})
    strings = {}
    for g in glyphs:
        pen = T2CharStringPen(500, None)
        if g not in ('.notdef', 'C32'):
            pen.moveTo((50, 0)); pen.lineTo((450, 0)); pen.lineTo((450, 600)); pen.lineTo((50, 600)); pen.closePath()
        strings[g] = pen.getCharString()
    fb.setupCFF(name, {'FullName': name}, strings, {})
    table = fb.font['CFF '].cff
    table.topDictIndex[0].Encoding = [encoding.get(c, '.notdef') for c in range(256)]
    out = io.BytesIO(); table.compile(out, fb.font)
    return out.getvalue()

body = 'A constant feed and reduced angular acceleration interpolation algorithm for multi-axis machining'
heading = 'COMPUTER AIDED DESIGN'
codes = ''.join(dict(zip('COMPUTERAIDSGN', 'gywiEeshqxbcdf')).get(c, c) for c in heading)  # what its content stream says
symbol = 'qq xq zqx'
fonts = {
    'FA': ('AdvPSBody', {ord(c): 'C%d' % ord(c) for c in body}),
    'FB': ('AdvPSHead', {ord(k): 'C%d' % ord(c) for k, c in zip(codes, heading)}),
    'FC': ('AdvPSSymb', {ord(c): 'C%d' % ord(c) for c in symbol}),
}
text = {'FA': body, 'FB': codes, 'FC': symbol}

objs = []
def add(body):
    objs.append(body); return len(objs)
font_refs = {}
for key, (name, enc) in fonts.items():
    data = cff(name, enc)
    ff = add(b'<< /Subtype /Type1C /Length %d >>\nstream\n' % len(data) + data + b'\nendstream')
    fd = add(b'<< /Type /FontDescriptor /FontName /ABCDEF+%s /Flags 4 /FontBBox [0 0 500 700] /ItalicAngle 0 /Ascent 700 /Descent 0 /CapHeight 700 /StemV 80 /FontFile3 %d 0 R >>' % (name.encode(), ff))
    font_refs[key] = add(b'<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+%s /FirstChar 0 /LastChar 255 /Widths [%s] /FontDescriptor %d 0 R >>' % (name.encode(), b' '.join([b'500'] * 256), fd))
content = b''.join(b'BT /%s 10 Tf 40 %d Td (%s) Tj ET\n' % (k.encode(), 700 - 40 * i, t.encode()) for i, (k, t) in enumerate(text.items()))
stream = add(b'<< /Length %d >>\nstream\n' % len(content) + content + b'\nendstream')
resources = b' '.join(b'/%s %d 0 R' % (k.encode(), r) for k, r in font_refs.items())
page = add(b'<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Resources << /Font << %s >> >> /Contents %d 0 R >>' % (len(objs) + 2, resources, stream))
pages = add(b'<< /Type /Pages /Kids [%d 0 R] /Count 1 >>' % page)
catalog = add(b'<< /Type /Catalog /Pages %d 0 R >>' % pages)
out = bytearray(b'%PDF-1.4\n'); offsets = []
for i, body in enumerate(objs, 1):
    offsets.append(len(out)); out += b'%d 0 obj\n' % i + body + b'\nendobj\n'
xref = len(out)
out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1) + b''.join(b'%010d 00000 n \n' % o for o in offsets)
out += b'trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, catalog, xref)
open(sys.argv[1], 'wb').write(out)
`;

const py = python();

test('numeric glyph names are decoded in English text fonts only', { skip: !py && 'no Python with PyMuPDF' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'glyphs-'));
  try {
    const pdf = join(dir, 'coded.pdf');
    execFileSync(py, ['-I', '-c', MAKE, pdf]);
    const page = JSON.parse(execFileSync(py, ['-I', join(import.meta.dirname, '..', 'native', 'text_layer.py'), pdf], { input: '{"page":1}', encoding: 'utf8' }));
    const lines = page.text.split('\n');
    assert.equal(lines[0], 'A constant feed and reduced angular acceleration interpolation algorithm for multi-axis machining');
    assert.equal(lines[1], 'COMPUTER AIDED DESIGN', 'the glyph names, not the codes');
    assert.ok(!/[qxz]/.test(lines[2]) && lines[2].includes('⟦未解码字形⟧'), 'a symbol font named the same way is not read as letters');
    assert.ok(page.chars.some(c => c.source === 'glyph-code'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
