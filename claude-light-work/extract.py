import sys,json,zipfile,xml.etree.ElementTree as ET,subprocess
path,ext=sys.argv[1:3]
LIMIT=60000
try:
 if ext=='.pdf':
  r=subprocess.run(['pdftotext','-f','1','-l','60','-layout',path,'-'],capture_output=True,timeout=18,check=True)
  text=r.stdout.decode('utf-8',errors='replace');note='PDF：最多读取前60页；扫描件可能没有可提取文字。'
 elif ext in ['.docx','.xlsx']:
  with zipfile.ZipFile(path) as z:
   infos=z.infolist()
   if len(infos)>3000 or sum(x.file_size for x in infos)>40*1024*1024:raise ValueError('文档解压后过大')
   names=z.namelist()
   def xml(n):
    b=z.read(n)
    if b'<!DOCTYPE' in b or b'<!ENTITY' in b:raise ValueError('不支持含实体声明的XML')
    return ET.fromstring(b)
   if ext=='.docx':
    root=xml('word/document.xml');text='\n'.join(''.join(p.itertext()) for p in root.iter() if p.tag.endswith('}p'));note='Word正文（不包含图片、批注和页眉页脚）。'
   else:
    shared=[]
    if 'xl/sharedStrings.xml' in names:shared=[''.join(t.itertext()) for t in xml('xl/sharedStrings.xml') if t.tag.endswith('}si')]
    sheets=sorted(n for n in names if n.startswith('xl/worksheets/sheet') and n.endswith('.xml'))[:10];parts=[]
    for n in sheets:
     parts.append('[工作表 '+n+']')
     for row in [r for r in xml(n).iter() if r.tag.endswith('}row')][:500]:
      cells=[]
      for c in list(row)[:80]:
       value=''.join(c.itertext())
       formula=next((v.text or '' for v in c if v.tag.endswith('}f')),None)
       if formula is not None:
        cached=next((v.text or '' for v in c if v.tag.endswith('}v')),'')
        value='[公式='+formula+'; 缓存值='+cached+']'
       if c.get('t')=='s':
        try:value=shared[int(value)]
        except (ValueError,IndexError):value='[无效共享字符串]'
       cells.append(c.get('r','')+'='+value)
      parts.append('\t'.join(cells))
     if sum(map(len,parts))>LIMIT:break
    text='\n'.join(parts);note='Excel：最多10张表，每表500行80列；公式不会执行，数字与日期可能是原始存储值。'
 else:
  b=open(path,'rb').read()
  try:text=b.decode('utf-8-sig')
  except UnicodeDecodeError:text=b.decode('gb18030',errors='replace')
  if '\x00' in text:raise ValueError('不支持二进制文件')
  note='文本文件内容。'
 print(json.dumps({'text':text[:LIMIT], 'truncated':len(text)>LIMIT,'note':note},ensure_ascii=False))
except Exception as e:
 print(json.dumps({'error':str(e)[:250]},ensure_ascii=False));sys.exit(1)
