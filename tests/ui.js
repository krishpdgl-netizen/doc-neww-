const {JSDOM}=require('jsdom'),fs=require('fs');
const {NEW,file}=require('./harness');
const html=fs.readFileSync('/home/claude/doc_comapare-main/index.html','utf8');
const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window;
w.IntersectionObserver=class{observe(){}};w.Element.prototype.scrollIntoView=function(){};w.XLSX=require('xlsx');w.JSZip=require('jszip');
const _m=require('mammoth');w.mammoth={convertToHtml:o=>_m.convertToHtml({buffer:Buffer.from(o.arrayBuffer)})};
const a=html.lastIndexOf('<script>')+8,b=html.indexOf('</script>',a);
w.eval(html.slice(a,b)+';window.__t={S,extract,diffBlocks,buildViewer,setActive,showPage};');
const h=w.__t,F=(n)=>new w.File([fs.readFileSync('corpus/'+n)],n);
const q=(sel,root=w.document)=>[...root.querySelectorAll(sel)];
async function run(name,oldF,newF,fake){
  let oc,nc;
  if(fake){oc=fake[0];nc=fake[1];}else{oc=await h.extract(F(oldF));nc=await h.extract(F(newF));}
  Object.assign(h.S,{oldFile:{name:oldF},newFile:{name:newF},oldContent:oc,newContent:nc,filter:'all',search:''});
  h.S.changes=h.diffBlocks(oc.blocks,nc.blocks);h.S.active=h.S.changes[0];
  h.buildViewer();
  const po=w.document.getElementById('pane-old'),pn=w.document.getElementById('pane-new');
  const first=h.S.changes[0];h.setActive(first.id);
  const ids=q('[data-id]',po).length+q('[data-id]',pn).length;
  console.log(`${name}: changes=${h.S.changes.length} list=${q('#change-list .ci').length} paneHighlights(old/new)=${q('[data-id]',po).length}/${q('[data-id]',pn).length} focus=${q('.focus-ring').length} marks=${q('mark.rm',po).length}/${q('mark.ad',pn).length}`);
  return {po,pn};
}
(async()=>{
  await run('TXT ','contract_v1.txt','contract_v2.txt');
  await run('DOCX','contract_v1.docx','contract_v2.docx');
  await run('HTML','contract_v1.html','contract_v2.html');
  await run('CSV ','prices_v1.csv','prices_v2.csv');
  // PDF pane: real word boxes from OCR'd scans, canvases stubbed (no browser rasteriser here)
  const oc=await NEW.extract(F('contract_v1_scan.pdf')),nc=await NEW.extract(F('contract_v2_scan.pdf'));
  const stub=c=>Object.assign(c,{type:'pdf',pdfDoc:{getPage:async()=>{throw new Error('stub')}}});
  const {po,pn}=await run('PDF (scan vs scan)','contract_v1_scan.pdf','contract_v2_scan.pdf',[stub(oc),stub(nc)]);
  const hl=q('.pdf-hl',pn)[0];console.log('  sample overlay style:',hl&&hl.getAttribute('style'),'| anchors old side:',q('.pdf-anchor',po).length);
  await NEW.stopOcr();process.exit(0);
})().catch(e=>{console.log('UI TEST ERROR',e.stack.split('\n').slice(0,5).join('\n'));process.exit(1);});
