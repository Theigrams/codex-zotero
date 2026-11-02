"""Long-lived MuPDF glyph text server. One JSON request per line on stdin, one reply per line on stdout.

  {"id": 1, "path": "/x.pdf", "page": 3}  ->  {"id": 1, "ok": true, "chars": [...], "repairs": n, "issues": n}

text_layer.py is the 0.12.0 prototype's verified glyph repair (ligatures, Σ/Λ/∑ from embedded glyph
names, explicit unresolved glyphs), plus numeric glyph names in fonts shown to be English text.
Run with -I so nothing next to the PDF can shadow imports.
"""
import ctypes
import json
import os
import sys

# PyMuPDF 1.28 returns None without a reference from get_texttrace (each span's "linewidth") and get_fonts,
# ~100 references per page and over a thousand on dense ones. Before Python 3.12 None is not immortal, so a
# long-lived process died with "none_dealloc" after a few dozen pages and every later page went unrepaired.
# Give None the effectively immortal count it has from 3.12 on (ob_refcnt is PyObject's first field).
if sys.version_info < (3, 12):
    ctypes.c_ssize_t.from_address(id(None)).value += 1 << 40

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import text_layer  # noqa: E402


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        req = {}
        try:
            req = json.loads(line)
            layer = text_layer.extract(req["path"], int(req["page"]))
            chars = [{"t": c["text"], "r": [round(v, 2) for v in c["rect"]], "src": c["source"]} for c in layer["chars"]]
            reply = {"id": req.get("id"), "ok": True, "chars": chars, "repairs": len(layer["repairs"]), "issues": len(layer["issues"])}
        except Exception as e:  # one bad page must not kill the server
            reply = {"id": req.get("id"), "ok": False, "error": str(e)}
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
