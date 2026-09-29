const T=require('tesseract.js');
const fs=require('fs'),path=require('path');
const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!DOCTYPE html><body></body>');
const w=dom.window;
Object.assign(globalThis,{document:w.document,DOMParser:w.DOMParser,FileReader:w.FileReader,File:w.File,Blob:w.Blob});
globalThis.requestAnimationFrame=cb=>setTimeout(cb,0);globalThis.cancelAnimationFrame=clearTimeout;
globalThis.XLSX=require('xlsx');const _m=require('mammoth');globalThis.mammoth={convertToHtml:o=>_m.convertToHtml(o.arrayBuffer?{buffer:Buffer.from(o.arrayBuffer)}:o)};globalThis.JSZip=require('jszip');
const engDir=path.dirname(require.resolve('@tesseract.js-data/eng/package.json'))+'/4.0.0_best_int';
globalThis.Tesseract={createWorker:async(l,n,o)=>{const w=await T.createWorker(l,n,{...o,langPath:engDir,cachePath:'/tmp/tcache',gzip:true});
  const rec=w.recognize.bind(w);
  // Node's tesseract.js takes buffers, the browser build takes canvases: bridge for the test only
  w.recognize=(img,...r)=>rec(img&&img.toDataURL?Buffer.from(img.toDataURL('image/png').split(',')[1],'base64'):img,...r);
  return w;}};
const pdfjs=require('pdfjs-dist/legacy/build/pdf.js');
pdfjs.GlobalWorkerOptions.workerSrc=require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
globalThis.window={requestAnimationFrame:cb=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,pdfjsLib:pdfjs};globalThis.pdfjsLib=pdfjs;const WIN={pdfjsLib:pdfjs,requestAnimationFrame:cb=>setTimeout(cb,0)};
globalThis.$=()=>null;
globalThis.esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function load(file,a,b,exports){
  const lines=fs.readFileSync(file,'utf8').split('\n');
  const s=lines.findIndex(l=>l.startsWith(a)),e=lines.findIndex((l,i)=>i>s&&l.startsWith(b));
  WIN.Tesseract=globalThis.Tesseract;return new Function('window',lines.slice(s,e).join('\n')+`\nreturn {${exports}};`)(WIN);
}
const NEW=load('/home/claude/doc_comapare-main/index.html','// ── Text normalisation','// ── State','extract,diffBlocks,diffXlsx,stopOcr');
const OLD=load('/home/claude/index.orig.html','// ── Extract content from any file type','// ── XLSX cell-level diff','extract,diffTexts');
const file=n=>new File([fs.readFileSync('corpus/'+n)],n);
module.exports={NEW,OLD,file};
