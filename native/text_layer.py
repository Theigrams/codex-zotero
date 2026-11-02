"""Read-only glyph extraction. PDFKit remains the renderer.
Unknown Unicode mappings are explicit; recovery uses embedded glyph names. Glyph names that are only a
number (C101) are read as Adobe StandardEncoding codes for a font whose decoded words are English, never
for a font that has not shown it (a symbol font named the same way decodes to junk).
"""
import io,json,math,os,sys,unicodedata,re
import pymupdf as fitz
from fontTools.cffLib import CFFFontSet
from fontTools.ttLib import TTFont
from fontTools.agl import toUnicode
from fontTools.encodings.StandardEncoding import StandardEncoding
VERSION='glyph-text-v3'
LIGATURES={chr(0xfb00+i):s for i,s in enumerate(['ff','fi','fl','ffi','ffl','st','st'])}
# Named mathematical glyph variants from embedded Type 1 fonts. These aliases
# describe glyph shapes; never map character codes globally (0x02 is NOT Sigma).
ALIASES={'Sigma1':'Σ','Lambda1':'Λ','summationdisplay':'∑','summationtext':'∑','integraldisplay':'∫','integraltext':'∫','parenleftbigg':'(','parenrightbigg':')','braceleftBigg':'{','radicalBig':'√'}
# Coded glyph names (3B2/Advent fonts in older Elsevier PDFs: C101 is "e", C174 "fi"; no ToUnicode). A font
# counts as coded when, over the first EVIDENCE_PAGES pages, its glyphs decode to at least MIN_WORDS
# dictionary words of 4+ letters and WORD_SHARE of all such words. Symbol and math fonts give no words.
CODED=re.compile(r'C(\d{1,3})$')
EVIDENCE_PAGES=30;MIN_WORDS=3;WORD_SHARE=.7
DICTIONARY='/usr/share/dict/words'
SUFFIXES=('s','es','ed','d','ing','ly','al','ally','er','ers','ation','ations')
_words=None;_coded={}
def clean(name):return re.sub(r'^[A-Z]{6}\+','',name)
def utf16(s):return len(s.encode('utf-16-le'))//2
def unknown(c):return any(unicodedata.category(v) in ('Cc','Co','Cs') or v in '�￼' for v in c)
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

def standard(glyph_name):
 m=CODED.match(glyph_name or '')
 if not m or int(m.group(1))>255:return ''
 name=StandardEncoding[int(m.group(1))]
 return '' if name=='.notdef' else toUnicode(name)

def known(word):
 global _words
 if _words is None:
  try:
   with open(DICTIONARY,encoding='utf-8',errors='ignore') as f:_words={w.strip().lower() for w in f}
  except OSError:_words=set()
 w=word.lower()
 return w in _words or any(w.endswith(s) and w[:-len(s)] in _words for s in SUFFIXES)

def english(text):
 words=[w for w in re.findall(r'[A-Za-z]+',text) if len(w)>=4]
 hits=sum(map(known,words))
 return hits>=MIN_WORDS and hits>=WORD_SHARE*len(words)

def page_lines(doc,page):
 """Each text line as [(font, rawdict char, needs restoring, embedded glyph name or None)]."""
 fonts=font_names(doc,page);traces={};unmapped=set()
 for span in page.get_texttrace():
  for cp,gid,origin,bbox in span['chars']:
   k=(clean(span['font']),round(origin[0],2),round(origin[1],2))
   traces.setdefault(k,[]).append(gid)
   if cp==65533:unmapped.add(k)
 raw=page.get_text('rawdict',flags=fitz.TEXTFLAGS_RAWDICT & ~fitz.TEXT_PRESERVE_IMAGES)
 for block in raw['blocks']:
  if block.get('type')!=0:continue
  for line in block.get('lines',[]):
   out=[]
   for span in line['spans']:
    font=clean(span['font']);names=fonts.get(font,[])
    for ch in span['chars']:
     k=(font,round(ch['origin'][0],2),round(ch['origin'][1],2))
     # rawdict retains CID placeholders so MuPDF still synthesizes word spaces.
     # texttrace flags unmapped Unicode, including otherwise printable CIDs.
     missing=unknown(ch['c']) or k in unmapped;glyph_name=None
     if missing:
      gids=set(traces.get(k,[]))
      if len(gids)==1:
       gid=next(iter(gids))
       if 0<=gid<len(names):glyph_name=names[gid]
     out.append((font,ch,missing,glyph_name))
   yield out

def coded_fonts(doc,path):
 """Fonts whose numeric glyph names decode to English; decided once per file."""
 st=os.stat(path);key=(path,st.st_mtime_ns,st.st_size)
 if key not in _coded:
  text={}
  for n in range(min(len(doc),EVIDENCE_PAGES)):
   for line in page_lines(doc,doc[n]):
    prev=None
    for font,ch,missing,glyph_name in line:
     parts=text.setdefault(font,[])
     if font!=prev:parts.append(' ');prev=font # a run of another font in between ends the word
     parts.append((standard(glyph_name) if missing else ch['c']) or ' ')
  _coded[key]={font for font,parts in text.items() if english(''.join(parts))}
 return _coded[key]

def extract(path,page_number):
 doc=fitz.open(path);page=doc[page_number-1]
 if page.rotation or abs(page.cropbox.x0)>.01 or abs(page.cropbox.y0)>.01:raise ValueError('暂不支持旋转或非零裁剪原点的 PDF 页面。')
 chars=[];parts=[];offset=0;line_id=0;repairs=[];issues=[];coded=None
 for line in page_lines(doc,page):
  if parts:parts.append('\n');offset+=1
  line_id+=1
  for font,ch,missing,glyph_name in line:
   value=ch['c'];source='unicode'
   if missing:
    restored=ALIASES.get(glyph_name) or (toUnicode(glyph_name) if glyph_name else '');source='embedded-glyph-name'
    if not restored and CODED.match(glyph_name or ''):
     if coded is None:coded=coded_fonts(doc,path)
     if font in coded:restored=standard(glyph_name);source='glyph-code'
    if restored and not unknown(restored):value=restored;repairs.append({'index':offset,'font':font,'glyph':glyph_name,'text':value})
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
