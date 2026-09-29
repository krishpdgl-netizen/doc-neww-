const {NEW,OLD,file}=require('./harness');
const show=(cs,n=40)=>cs.forEach(c=>console.log(`  #${c.id} ${c.type.padEnd(8)} ${c.sev.padEnd(8)} [${(c.cats||[]).join(',')}]${c.page!=null?' p'+(c.page+1):''}${c.ocr?' OCR':''}${c.conf!=null?' c'+c.conf:''} | -${(c.rmText||'').slice(0,n)} | +${(c.addText||'').slice(0,n)}`));
(async()=>{
  const pairs=process.argv.slice(2).map(p=>p.split(','));
  for(const [a,b,mode] of pairs){
    console.log(`\n=== ${a}  vs  ${b} ===`);
    const t0=Date.now();
    try{
      const oc=await NEW.extract(file(a)),nc=await NEW.extract(file(b));
      const cs=(oc.type==='xlsx')?NEW.diffXlsx(oc,nc):NEW.diffBlocks(oc.blocks,nc.blocks);
      console.log(`NEW: ${cs.length} changes (${((Date.now()-t0)/1000).toFixed(1)}s) ocrPages=${oc.ocrPageCount||0}/${nc.ocrPageCount||0}`);show(cs);
      if(mode==='old'){
        const o1=await OLD.extract(file(a)),o2=await OLD.extract(file(b));
        const oc2=OLD.diffTexts(o1.text,o2.text);
        console.log(`OLD engine: ${oc2.length} changes`);show(oc2.slice(0,12),40);
      }
    }catch(e){console.log('  ERROR',e.message);}
  }
  await NEW.stopOcr();process.exit(0);
})();
