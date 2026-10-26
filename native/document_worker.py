"""Local layout detection and PDF slicing. Never performs OCR or sends network requests.

PP-DocLayoutV2 ONNX input/output follows PaddlePaddle's published inference
contract, also used by MinerU. Model weights are installed separately.
"""
import json
import os
import sys

import pymupdf as fitz

LABELS = ['abstract', 'algorithm', 'aside_text', 'chart', 'content',
          'display_formula', 'doc_title', 'figure_title', 'footer', 'footer_image',
          'footnote', 'formula_number', 'header', 'header_image', 'image',
          'inline_formula', 'number', 'paragraph_title', 'reference',
          'reference_content', 'seal', 'table', 'text', 'vertical_text', 'vision_footnote']
KINDS = {'display_formula': 'formula', 'inline_formula': 'formula', 'table': 'table',
         'chart': 'figure', 'image': 'figure', 'header_image': 'figure',
         'footer_image': 'figure', 'doc_title': 'title', 'paragraph_title': 'title',
         'figure_title': 'caption', 'vision_footnote': 'caption'}
SESSION = None


def layout(req):
    global SESSION
    with fitz.open(req['path']) as doc:
        page = doc[req['page'] - 1]
        if not req.get('model') or not os.path.isfile(req['model']):
            blocks = []
            for i, block in enumerate(page.get_text('blocks')):
                x0, y0, x1, y1, text, _, kind = block
                if x1 > x0 and y1 > y0:
                    blocks.append({'id': str(i), 'type': 'figure' if kind == 1 else 'text',
                                   'rect': [x0, y0, x1-x0, y1-y0],
                                   'text': text.strip() if kind == 0 else '', 'score': None})
            return {'blocks': blocks, 'engine': 'mupdf', 'notice': '版面模型未安装，暂用 PDF 原生块。'}
        import numpy as np
        import onnxruntime as ort
        from PIL import Image
        if SESSION is None:
            options = ort.SessionOptions()
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            SESSION = ort.InferenceSession(req['model'], options, providers=['CPUExecutionProvider'])
        pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), colorspace=fitz.csRGB, alpha=False)
        image = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
        arr = np.asarray(image.resize((800, 800), Image.Resampling.BICUBIC), dtype=np.float32) / 255.0
        feed = {'image': arr.transpose(2, 0, 1)[None],
                'scale_factor': np.array([[800/pix.height, 800/pix.width]], dtype=np.float32)}
        if any(x.name == 'im_shape' for x in SESSION.get_inputs()):
            feed['im_shape'] = np.array([[800, 800]], dtype=np.float32)
        detections, counts = SESSION.run(None, feed)
        rows = list(detections[:int(counts[0])])
        if rows and len(rows[0]) >= 8:
            rows.sort(key=lambda r: (float(r[6]), -float(r[7])))
        blocks = []
        for row in rows:
            label, score = int(row[0]), float(row[1])
            if not 0 <= label < len(LABELS) or score < (0.4 if label in [5, 6, 15, 17, 22, 23] else 0.5):
                continue
            name = LABELS[label]
            if name in ['formula_number', 'number', 'header', 'footer']:
                continue
            x0, y0, x1, y1 = [float(v) for v in row[2:6]]
            rect = fitz.Rect(x0*page.rect.width/pix.width, y0*page.rect.height/pix.height,
                             x1*page.rect.width/pix.width, y1*page.rect.height/pix.height) & page.rect
            if rect.is_empty or rect.width < 2 or rect.height < 2:
                continue
            kind = KINDS.get(name, 'text')
            # Multi-label detections must not put two identical click targets on a paragraph.
            def duplicate(b):
                other = fitz.Rect(b['rect'][0], b['rect'][1], b['rect'][0]+b['rect'][2], b['rect'][1]+b['rect'][3])
                overlap = rect & other
                area = max(0, overlap.width) * max(0, overlap.height)
                return b['type'] == kind and area / max(1, rect.width * rect.height) > 0.9
            if any(duplicate(b) for b in blocks):
                continue
            blocks.append({'id': str(len(blocks)), 'type': kind, 'label': name,
                           'rect': [round(rect.x0, 2), round(rect.y0, 2), round(rect.width, 2), round(rect.height, 2)],
                           'text': page.get_text('text', clip=rect).strip(), 'score': round(score, 3)})
        return {'blocks': blocks, 'engine': 'pp-doclayout-v2'}


def run(req):
    if req['op'] == 'layout':
        return layout(req)
    if req['op'] == 'slice':
        with fitz.open(req['path']) as doc, fitz.open() as out:
            out.insert_pdf(doc, from_page=req['from']-1, to_page=req['to']-1)
            out.save(req['output'], garbage=4, deflate=True)
        return {'path': req['output']}
    raise ValueError('Unknown document operation')


for line in sys.stdin:
    req = {}
    try:
        req = json.loads(line)
        result = {'id': req['id'], 'ok': True, **run(req)}
    except Exception as error:
        result = {'id': req.get('id'), 'ok': False, 'error': str(error)}
    print(json.dumps(result, ensure_ascii=False), flush=True)
