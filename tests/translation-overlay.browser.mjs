import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  await page.route('**/overlay-test',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><style>
    .reader{width:400px;height:300px;overflow:auto;position:relative}
    img{display:block;width:100%}.tl-overlay{position:absolute;pointer-events:none}
    .tl-block{position:absolute;overflow:hidden;line-height:1.1}
    </style><div class="reader webtoon"><img></div>`}));
  await page.goto((process.env.NYORA_TEST_URL||'http://127.0.0.1:8899')+'/overlay-test');
  const result=await page.evaluate(async()=>{
    const {attachOverlay}=await import('/core/translate/overlay.js');
    const img=document.querySelector('img'),reader=document.querySelector('.reader');
    const canvas=new OffscreenCanvas(400,600);canvas.getContext('2d');img.src=URL.createObjectURL(await canvas.convertToBlob());await img.decode();
    const overlay=attachOverlay(img);
    const blocks=[{x:50,y:60,w:160,h:100,bg:'rgb(255,255,255)'}];
    overlay.setBlocks(blocks,['A longer translated speech bubble to exercise fitting.'],null);
    const frames=async()=>{for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);};
    await frames();
    let mutations=0;
    const observer=new MutationObserver(records=>mutations+=records.filter(r=>r.target.matches('.tl-block')).length);
    observer.observe(document.querySelector('.tl-overlay'),{subtree:true,attributes:true,attributeFilter:['style']});
    for(let i=0;i<8;i++){reader.scrollTop=i*20;await frames();}
    const scrollMutations=mutations;
    reader.style.width='320px';await frames();
    const resizeMutations=mutations-scrollMutations;
    overlay.setBlocks(blocks,['Changed text'],null);await frames();
    const text=document.querySelector('.tl-block').textContent;
    const fontSize=document.querySelector('.tl-block').style.fontSize;
    observer.disconnect();overlay.destroy();URL.revokeObjectURL(img.src);
    return {scrollMutations,resizeMutations,text,fontSize,remaining:document.querySelectorAll('.tl-overlay').length};
  });
  assert.equal(result.scrollMutations,0,'Scrolling must not repeat font fitting');
  assert(result.resizeMutations>0,'Resizing must refit translated text');
  assert.equal(result.text,'Changed text');assert(result.fontSize);assert.equal(result.remaining,0);
  console.log('PASS: translation overlays avoid repeated layout on scroll, refit on resize/text change, and clean up');
}finally{await browser.close();}
