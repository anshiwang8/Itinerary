import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from '@playwright/test';

// Investigation recorder, not a regression pass/fail gate. Requires a mock
// server on port 3100; browser request blocking does not mock server providers.
// Chromium uses trusted touch input. WebKit events and the atomic re-grab are
// synthetic; they corroborate application bindings/CSS, not native iOS physics.
const engine = process.argv[2] || 'chromium';
const initialHeight = Number(process.argv[3] || 844);
if (!['chromium', 'webkit'].includes(engine) || !Number.isInteger(initialHeight) || initialHeight < 600) {
  throw new Error('Usage: node investigations/mobile-ui-fix/probe.mjs [chromium|webkit] [height >= 600]');
}
const outputRoot = process.env.MOBILE_PROBE_OUTPUT || path.join(process.cwd(), 'test-results', 'mobile-investigation');
const out = path.join(outputRoot, engine + (initialHeight === 844 ? '' : `-${initialHeight}`));
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await ({chromium, webkit})[engine].launch({ headless: true });
  const context = await browser.newContext({ viewport: {width:390,height:initialHeight}, deviceScaleFactor:3, isMobile:true, hasTouch:true });
  const page = await context.newPage();
  await page.route(/^https?:\/\//, route => ['localhost','127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
  await page.locator('.prompt__input').fill('dinner and drinks then dessert then coffee at 7pm');
  await page.locator('.prompt__go').click();
  await page.locator('.clarify:visible, .msheet:visible, .empty__err').first().waitFor({state:'visible',timeout:30000});
  const skip = page.getByRole('button',{name:'Skip, just plan it'});
  if(await skip.isVisible()) await skip.click();
  await page.locator('.msheet').waitFor({state:'visible',timeout:30000});
  const dismiss = page.getByRole('button',{name:'Dismiss map warning'});
  if (await dismiss.isVisible()) await dismiss.click();
  await page.waitForTimeout(500);
  await page.evaluate(()=>{window.__touchCancels=0;document.addEventListener('touchcancel',()=>window.__touchCancels++,true)});
  const grip = page.locator('.msheet__draghandle');
  const session = engine === 'chromium' ? await context.newCDPSession(page) : null;
  async function touch(type, x, y, target='.msheet__draghandle') {
    if (session) await session.send('Input.dispatchTouchEvent', {type, touchPoints:type==='touchEnd'?[]:[{x,y,id:1}]});
    else await page.evaluate(({type,x,y,target}) => {
      const el=document.querySelector(target);
      const t={identifier:1,target:el,clientX:x,clientY:y};
      const names={touchStart:'touchstart',touchMove:'touchmove',touchEnd:'touchend'};
      const event=new Event(names[type], {bubbles:true,cancelable:true});
      Object.defineProperties(event,{touches:{value:type==='touchEnd'?[]:[t]},changedTouches:{value:[t]}});
      el.dispatchEvent(event);
    }, {type,x,y,target});
  }
  async function snap(key) { await grip.press(key); await page.waitForTimeout(400); }
  async function sample(label) {
    return await page.evaluate(label => {
      const s=document.querySelector('.msheet'), b=document.querySelector('.topbar'), tr=document.querySelector('.msheet__track'), full=document.querySelector('.msheet__full'), body=document.querySelector('.msheet__body');
      const r=s.getBoundingClientRect(), v=window.visualViewport;
      return {label,at:performance.now(),sheetTop:r.top,sheetHeight:r.height,transform:getComputedStyle(s).transform,content:s.dataset.state,dragging:s.classList.contains('msheet--dragging'),touchCancelCount:window.__touchCancels,ariaExpanded:document.querySelector('.msheet__draghandle').getAttribute('aria-expanded'),bodyHidden:body.hidden,bodyHeight:body.getBoundingClientRect().height,opacity:getComputedStyle(document.querySelector('.msheet__bg--opaque')).opacity,track:{height:tr.clientHeight,scrollHeight:tr.scrollHeight,scrollTop:tr.scrollTop,overflowY:getComputedStyle(tr).overflowY,touchAction:getComputedStyle(tr).touchAction},fullScroll:full.scrollTop,documentY:window.scrollY,documentScroll:document.scrollingElement.scrollTop,toolbarTop:b.getBoundingClientRect().top,toolbarHeight:b.getBoundingClientRect().height,toolbarVisualTop:(b.getBoundingClientRect().top-v.offsetTop)*v.scale,viewport:{height:v.height,offsetTop:v.offsetTop,scale:v.scale},innerHeight:innerHeight};
    },label);
  }
  async function start() { const b=await grip.boundingBox(); const p={x:b.x+b.width/2,y:b.y+b.height/2}; await touch('touchStart',p.x,p.y);return p; }
  async function drag(p,dy,steps=20,delay=35) {
    for(let i=1;i<=steps;i++){await touch('touchMove',p.x,p.y-dy*i/steps);await page.waitForTimeout(delay);}
  }
  const result={engine,version:browser.version(),input:session?'trusted Chromium CDP':'synthetic TouchEvent binding probe; not native iOS gesture input',baseline:await sample('baseline')};

  await snap('Home');
  let p=await start();
  await drag(p,245);
  result.peekExpansion=[await sample('finger held after 245px upward drag')];
  await page.screenshot({path:path.join(out,'01-peek-drag-held.png')});
  await page.waitForTimeout(150);
  await touch('touchEnd',p.x,p.y-245);
  result.peekExpansion.push(await sample('just released'));
  await page.waitForTimeout(100);result.peekExpansion.push(await sample('release+100ms'));
  await page.waitForTimeout(300);result.peekExpansion.push(await sample('settled'));
  await page.screenshot({path:path.join(out,'02-half-settled.png')});

  result.halfOverflow=await page.locator('.msheet__track').evaluate(el => ({height:el.clientHeight,scrollHeight:el.scrollHeight,cards:[...el.children].map(c=>({kind:c.className,height:c.getBoundingClientRect().height,text:c.textContent.slice(0,150)}))}));
  if(session){
    const b=await page.locator('.msheet__track').boundingBox();
    p={x:b.x+b.width/2,y:b.y+b.height-15};
    await touch('touchStart',p.x,p.y);await drag(p,140,12,30);await touch('touchEnd',p.x,p.y-140);await page.waitForTimeout(400);
    result.halfVerticalSwipe=await sample('vertical swipe inside half cards');
  }

  await snap('Home');p=await start();await drag(p,130,10,30);
  result.geometryInterruption=[await sample('held before topbar geometry change')];
  await page.locator('.topbar').evaluate(el=>el.style.height=`${el.getBoundingClientRect().height+8}px`);
  await page.waitForTimeout(80);result.geometryInterruption.push(await sample('80ms after topbar +8px'));
  await touch('touchMove',p.x,p.y-220);await page.waitForTimeout(80);result.geometryInterruption.push(await sample('same finger moved another90px'));
  await touch('touchEnd',p.x,p.y-220);await page.waitForTimeout(350);result.geometryInterruption.push(await sample('finger released'));
  await page.locator('.topbar').evaluate(el=>el.style.removeProperty('height'));await page.waitForTimeout(350);

  await snap('Home');p=await start();await drag(p,130,10,30);
  result.viewportInterruption=[await sample('held before viewport resize')];
  await page.setViewportSize({width:390,height:initialHeight-40});await page.waitForTimeout(80);result.viewportInterruption.push(await sample('viewport 40px shorter'));
  await touch('touchMove',p.x,p.y-220);await page.waitForTimeout(80);result.viewportInterruption.push(await sample('same finger moved after resize'));
  await touch('touchEnd',p.x,p.y-220);await page.waitForTimeout(350);
  await page.setViewportSize({width:390,height:initialHeight});await page.waitForTimeout(350);

  await snap('Home'); await grip.click();await page.waitForTimeout(400);
  await grip.click();await page.waitForTimeout(60);
  result.regrab=await grip.evaluate(el=>{
    const s=el.closest('.msheet'),o=s.querySelector('.msheet__bg--opaque');
    const box=el.getBoundingClientRect();
    const t={identifier:77,target:el,clientX:box.x+box.width/2,clientY:box.y+box.height/2};
    const read=()=>({sheetTop:s.getBoundingClientRect().top,opacity:Number(getComputedStyle(o).opacity),dragging:s.classList.contains('msheet--dragging')});
    const before=read();const e=new Event('touchstart',{bubbles:true});Object.defineProperties(e,{touches:{value:[t]},changedTouches:{value:[t]}});el.dispatchEvent(e);
    const after=read();const end=new Event('touchend',{bubbles:true});Object.defineProperties(end,{touches:{value:[]},changedTouches:{value:[t]}});el.dispatchEvent(end);
    return {method:'atomic synthetic regrab during real sheet animation',before,after};
  });
  await page.waitForTimeout(400);

  await snap('Home');
  result.mapScroll=[await sample('before map gesture')];
  if(session){p={x:345,y:450};await touch('touchStart',p.x,p.y);await drag(p,180,12,30);await touch('touchEnd',p.x,p.y-180);await page.waitForTimeout(400);result.mapScroll.push(await sample('after map gesture'));}
  await page.locator('.topbar__input').focus();result.mapScroll.push(await sample('input focused'));
  await page.locator('.topbar__input').evaluate(el=>el.blur());await page.waitForTimeout(200);result.mapScroll.push(await sample('input blurred'));
  if(session){
    await session.send('Emulation.setPageScaleFactor',{pageScaleFactor:1.25});await page.waitForTimeout(400);
    result.zoomedMap=[await sample('controlled page scale1.25')];
    p={x:275,y:430};await touch('touchStart',p.x,p.y);await drag(p,150,12,30);await touch('touchEnd',p.x,p.y-150);await page.waitForTimeout(400);
    result.zoomedMap.push(await sample('map-area pan after controlled zoom'));
    await page.screenshot({path:path.join(out,'03-zoomed-map-pan.png')});
  }

  fs.writeFileSync(path.join(out,'measurements.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  await context.close();await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
