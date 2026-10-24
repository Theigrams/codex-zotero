"""Read-only glyph extraction. PDFKit remains the renderer.
Unknown Unicode mappings are explicit; recovery uses embedded glyph names, not prose.
"""
import io,json,math,sys,unicodedata,re
import pymupdf as fitz
from fontTools.cffLib import CFFFontSet
from fontTools.ttLib import TTFont
from fontTools.agl import toUnicode
VERSION='glyph-text-v2'
LIGATURES={chr(0xfb00+i):s for i,s in enumerate(['ff','fi','fl','ffi','ffl','st','st'])}
# Named mathematical glyph variants from embedded Type 1 fonts. These aliases
# describe glyph shapes; never map character codes globally (0x02 is NOT Sigma).
ALIASES={'Sigma1':'Σ','Lambda1':'Λ','summationdisplay':'∑','summationtext':'∑','integraldisplay':'∫','integraltext':'∫','parenleftbigg':'(','parenrightbigg':')','braceleftBigg':'{','radicalBig':'√'}
def clean(name):return re.sub(r'^[A-Z]{6}\+','',name)
def utf16(s):return len(s.encode('utf-16-le'))//2
def unknown(c):return any(unicodedata.category(v) in ('Cc','Co','Cs') or v in '\ufffd\ufffc' for v in c)
def font_names(doc,page):
 result={};ambiguous=set()
 for row in page.get_fonts(full=True):
  name=clean(row[3]);names=[]
  try:
   _,ext,_,data=doc.extract_font(row[0])
   if ext=='cff':
    c=CFFFontSet();c.decompile(io.BytesIO(data),None);names=c[c.fontNames[0]].charset
   elif data:
    f=TTFont(io.BytesIO(data));names=f.getGlyphOrder()
  except Exception:pass
  if name in result and names!=result[name]:ambiguous.add(name)
  result[name]=names
 for name in ambiguous:result[name]=[]
 return result

def extract(path,page_number):
 doc=fitz.open(path);page=doc[page_number-1]
 if page.rotation or abs(page.cropbox.x0)>.01 or abs(page.cropbox.y0)>.01:raise ValueError('暂不支持旋转或非零裁剪原点的 PDF 页面。')
 fonts=font_names(doc,page);traces={};unmapped=set()
 for span in page.get_texttrace():
  for cp,gid,origin,bbox in span['chars']:
   k=(clean(span['font']),round(origin[0],2),round(origin[1],2))
   traces.setdefault(k,[]).append(gid)
   if cp==65533:unmapped.add(k)
 raw=page.get_text('rawdict',flags=fitz.TEXTFLAGS_RAWDICT & ~fitz.TEXT_PRESERVE_IMAGES)
 chars=[];parts=[];offset=0;line_id=0;repairs=[];issues=[]
 for block in raw['blocks']:
  if block.get('type')!=0:continue
  for line in block.get('lines',[]):
   if parts:parts.append('\n');offset+=1
   line_id+=1
   for span in line['spans']:
    font=clean(span['font'])
    for ch in span['chars']:
     value=ch['c'];source='unicode';glyph_name=None
     k=(font,round(ch['origin'][0],2),round(ch['origin'][1],2))
     # rawdict retains CID placeholders so MuPDF still synthesizes word spaces.
     # texttrace flags unmapped Unicode, including otherwise printable CIDs.
     if unknown(value) or k in unmapped:
      gids=set(traces.get(k,[]));names=fonts.get(font,[])
      if len(gids)==1:
       gid=next(iter(gids))
       if 0<=gid<len(names):glyph_name=names[gid]
      restored=ALIASES.get(glyph_name) or (toUnicode(glyph_name) if glyph_name else '')
      if restored and not unknown(restored):value=restored;source='embedded-glyph-name';repairs.append({'index':offset,'font':font,'glyph':glyph_name,'text':value})
      else:value='⟦未解码字形⟧';source='unresolved';issues.append({'index':offset,'font':font,'glyph':glyph_name})
     normalized=''.join(LIGATURES.get(v,v) for v in value)
     if normalized!=value:source='ligature';repairs.append({'index':offset,'font':font,'text':normalized,'glyph':value})
     value=normalized;x0,y0,x1,y1=ch['bbox'];length=utf16(value)
     if not all(math.isfinite(v) for v in ch['bbox']):raise ValueError('Invalid glyph bounds')
     # Keep a compound ligature as one hit target with a multi-unit text range.
     chars.append({'index':offset,'endIndex':offset+length-1,'text':value,'rect':[x0,y0,x1-x0,y1-y0],'line':line_id,'font':font,'source':source})
     parts.append(value);offset+=length
 return {'text':''.join(parts),'chars':chars,'width':page.rect.width,'height':page.rect.height,'page':page_number,'pageCount':len(doc),'pageLabel':page.get_label() or str(page_number),'geometryVersion':VERSION,'textVersion':VERSION,'engine':'Apple PDFKit','textEngine':'MuPDF + embedded glyph names','repairs':repairs,'issues':issues}
if __name__=='__main__':
 try:
  request=json.load(sys.stdin);result=extract(sys.argv[1],request.get('page',1));print(json.dumps(result,ensure_ascii=False))
 except Exception as e:print(json.dumps({'error':str(e)}));sys.exit(1)
