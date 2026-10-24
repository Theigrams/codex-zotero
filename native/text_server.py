"""Long-lived MuPDF glyph text server. One JSON request per line on stdin, one reply per line on stdout.

  {"id": 1, "path": "/x.pdf", "page": 3}  ->  {"id": 1, "ok": true, "chars": [...], "repairs": n, "issues": n}

text_layer.py is the 0.12.0 prototype's verified glyph repair (ligatures, Σ/Λ/∑ from embedded glyph
names, explicit unresolved glyphs), copied unchanged. Run with -I so nothing next to the PDF can shadow imports.
"""
import json
import os
import sys

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
