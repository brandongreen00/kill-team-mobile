import { chromium } from '@playwright/test';
import { createServer } from 'vite';
const server = await createServer({ server:{port:5399}, logLevel:'error' });
await server.listen();
const b = await chromium.launch();
const cases = [
  ['iphone13-landscape-real', 844, 390, 3],
  ['review-deck-750x342',     750, 342, 3],
  ['iphone-se-landscape',     667, 375, 2],
  ['desktop-1440',           1440, 900, 1],
  ['tablet-1100x800',        1100, 800, 1],
];
for (const [name,w,h,dpr] of cases) {
  const ctx = await b.newContext({ viewport:{width:w,height:h}, deviceScaleFactor:dpr, isMobile: dpr>1 });
  const p = await ctx.newPage();
  await p.goto('http://localhost:5399/', { waitUntil:'networkidle' });
  await p.waitForSelector('.topbar');
  const r = await p.evaluate(() => {
    const sheet = document.querySelector('.sheet');
    const stage = document.querySelector('.stage');
    const board = document.querySelector('svg.board-main') || document.querySelector('svg.board');
    const grab = document.querySelector('.sheet-grab');
    const rails = document.querySelectorAll('.desktop-layout .rail');
    const bb = e => e ? e.getBoundingClientRect() : null;
    return {
      layout: rails.length ? 'desktop' : (sheet && sheet.classList.contains('is-side') ? 'side' : 'compact'),
      hasGrab: !!grab,
      sheet: bb(sheet) && {w:Math.round(bb(sheet).width), h:Math.round(bb(sheet).height)},
      stage: bb(stage) && {w:Math.round(bb(stage).width), h:Math.round(bb(stage).height)},
      board: bb(board) && {w:Math.round(bb(board).width), h:Math.round(bb(board).height)},
      matchSide: matchMedia('(max-height: 560px) and (min-width: 640px)').matches,
      matchDesktop: matchMedia('(min-width: 1200px)').matches,
    };
  });
  console.log(name.padEnd(26), JSON.stringify(r));
  await ctx.close();
}
await b.close(); await server.close();
