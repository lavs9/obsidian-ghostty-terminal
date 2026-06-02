import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'module';
import { readFileSync, writeFileSync } from 'fs';

// ─── Block / box-drawing character patch ─────────────────────────────────────
// ghostty-web renders ALL characters via fillText(). Fonts like D2Coding
// Ligature embed padding in their block/box glyphs, producing visible gaps on
// macOS (1px horizontal margin, ~5px vertical gap). We intercept U+2580–259F
// (block elements) and U+2500–2570 (box-drawing) and draw precise filled
// rectangles instead, matching how native Ghostty renders them.
const BLOCK_CHAR_FNS = `
function _drawBlockChar(ctx,cp,x,y,w,h){
  const _t=ctx.getTransform(),_sx=_t.a||1,_sy=_t.d||1;
  const x0=Math.floor(x*_sx)/_sx,y0=Math.floor(y*_sy)/_sy;
  const W=Math.ceil((x+w)*_sx)/_sx-x0,H=Math.ceil((y+h)*_sy)/_sy-y0;
  const h2=H/2,w2=W/2,h8=H/8,w8=W/8;
  switch(cp){
    case 0x2580:ctx.fillRect(x0,y0,W,h2);break;
    case 0x2581:ctx.fillRect(x0,y0+H*7/8,W,h8);break;
    case 0x2582:ctx.fillRect(x0,y0+H*3/4,W,H/4);break;
    case 0x2583:ctx.fillRect(x0,y0+H*5/8,W,H*3/8);break;
    case 0x2584:ctx.fillRect(x0,y0+h2,W,h2);break;
    case 0x2585:ctx.fillRect(x0,y0+H*3/8,W,H*5/8);break;
    case 0x2586:ctx.fillRect(x0,y0+H/4,W,H*3/4);break;
    case 0x2587:ctx.fillRect(x0,y0+h8,W,H*7/8);break;
    case 0x2588:ctx.fillRect(x0,y0,W,H);break;
    case 0x2589:ctx.fillRect(x0,y0,W*7/8,H);break;
    case 0x258A:ctx.fillRect(x0,y0,W*3/4,H);break;
    case 0x258B:ctx.fillRect(x0,y0,W*5/8,H);break;
    case 0x258C:ctx.fillRect(x0,y0,w2,H);break;
    case 0x258D:ctx.fillRect(x0,y0,W*3/8,H);break;
    case 0x258E:ctx.fillRect(x0,y0,W/4,H);break;
    case 0x258F:ctx.fillRect(x0,y0,w8,H);break;
    case 0x2590:ctx.fillRect(x0+w2,y0,w2,H);break;
    case 0x2591:{const _a=ctx.globalAlpha;ctx.globalAlpha*=0.25;ctx.fillRect(x0,y0,W,H);ctx.globalAlpha=_a;break;}
    case 0x2592:{const _a=ctx.globalAlpha;ctx.globalAlpha*=0.5;ctx.fillRect(x0,y0,W,H);ctx.globalAlpha=_a;break;}
    case 0x2593:{const _a=ctx.globalAlpha;ctx.globalAlpha*=0.75;ctx.fillRect(x0,y0,W,H);ctx.globalAlpha=_a;break;}
    case 0x2594:ctx.fillRect(x0,y0,W,h8);break;
    case 0x2595:ctx.fillRect(x0+W*7/8,y0,w8,H);break;
    case 0x2596:ctx.fillRect(x0,y0+h2,w2,h2);break;
    case 0x2597:ctx.fillRect(x0+w2,y0+h2,w2,h2);break;
    case 0x2598:ctx.fillRect(x0,y0,w2,h2);break;
    case 0x2599:ctx.fillRect(x0,y0,w2,H);ctx.fillRect(x0+w2,y0+h2,w2,h2);break;
    case 0x259A:ctx.fillRect(x0,y0,w2,h2);ctx.fillRect(x0+w2,y0+h2,w2,h2);break;
    case 0x259B:ctx.fillRect(x0,y0,W,h2);ctx.fillRect(x0,y0+h2,w2,h2);break;
    case 0x259C:ctx.fillRect(x0,y0,W,h2);ctx.fillRect(x0+w2,y0+h2,w2,h2);break;
    case 0x259D:ctx.fillRect(x0+w2,y0,w2,h2);break;
    case 0x259E:ctx.fillRect(x0+w2,y0,w2,h2);ctx.fillRect(x0,y0+h2,w2,h2);break;
    case 0x259F:ctx.fillRect(x0+w2,y0,w2,h2);ctx.fillRect(x0,y0+h2,W,h2);break;
  }
}
function _drawBoxChar(ctx,cp,x0,y0,W,H,sx,sy){
  const L=1,K=2;
  const lhY=Math.floor((y0+H/2)*sy)/sy,lvX=Math.floor((x0+W/2)*sx)/sx;
  const khY=Math.floor((y0+H/2-0.5)*sy)/sy,kvX=Math.floor((x0+W/2-0.5)*sx)/sx;
  const d1Y=Math.floor((y0+H/2-2)*sy)/sy,d2Y=Math.floor((y0+H/2+1)*sy)/sy;
  const d1X=Math.floor((x0+W/2-2)*sx)/sx,d2X=Math.floor((x0+W/2+1)*sx)/sx;
  const xR=x0+W,yB=y0+H;
  const fh=(y,t,a,w)=>ctx.fillRect(a??x0,y,w??W,t);
  const fv=(x,t,b,h)=>ctx.fillRect(x,b??y0,t,h??H);
  switch(cp){
    case 0x2500:fh(lhY,L);break; case 0x2501:fh(khY,K);break;
    case 0x2502:fv(lvX,L);break; case 0x2503:fv(kvX,K);break;
    case 0x250C:fh(lhY,L,lvX,xR-lvX);fv(lvX,L,lhY,yB-lhY);break;
    case 0x250F:fh(khY,K,kvX,xR-kvX);fv(kvX,K,khY,yB-khY);break;
    case 0x2510:fh(lhY,L,x0,lvX-x0+L);fv(lvX,L,lhY,yB-lhY);break;
    case 0x2513:fh(khY,K,x0,kvX-x0+K);fv(kvX,K,khY,yB-khY);break;
    case 0x2514:fh(lhY,L,lvX,xR-lvX);fv(lvX,L,y0,lhY-y0+L);break;
    case 0x2517:fh(khY,K,kvX,xR-kvX);fv(kvX,K,y0,khY-y0+K);break;
    case 0x2518:fh(lhY,L,x0,lvX-x0+L);fv(lvX,L,y0,lhY-y0+L);break;
    case 0x251B:fh(khY,K,x0,kvX-x0+K);fv(kvX,K,y0,khY-y0+K);break;
    case 0x251C:fv(lvX,L);fh(lhY,L,lvX,xR-lvX);break;
    case 0x2523:fv(kvX,K);fh(khY,K,kvX,xR-kvX);break;
    case 0x2524:fv(lvX,L);fh(lhY,L,x0,lvX-x0+L);break;
    case 0x252B:fv(kvX,K);fh(khY,K,x0,kvX-x0+K);break;
    case 0x252C:fh(lhY,L);fv(lvX,L,lhY,yB-lhY);break;
    case 0x2533:fh(khY,K);fv(kvX,K,khY,yB-khY);break;
    case 0x2534:fh(lhY,L);fv(lvX,L,y0,lhY-y0+L);break;
    case 0x253B:fh(khY,K);fv(kvX,K,y0,khY-y0+K);break;
    case 0x253C:fh(lhY,L);fv(lvX,L);break;
    case 0x254B:fh(khY,K);fv(kvX,K);break;
    case 0x2550:fh(d1Y,L);fh(d2Y,L);break;
    case 0x2551:fv(d1X,L);fv(d2X,L);break;
    case 0x2554:fh(d1Y,L,d1X,xR-d1X);fh(d2Y,L,d2X,xR-d2X);fv(d1X,L,d1Y,yB-d1Y);fv(d2X,L,d2Y,yB-d2Y);break;
    case 0x2557:fh(d1Y,L,x0,d2X-x0+L);fh(d2Y,L,x0,d1X-x0+L);fv(d2X,L,d1Y,yB-d1Y);fv(d1X,L,d2Y,yB-d2Y);break;
    case 0x255A:fh(d1Y,L,d1X,xR-d1X);fh(d2Y,L,d2X,xR-d2X);fv(d1X,L,y0,d2Y-y0+L);fv(d2X,L,y0,d1Y-y0+L);break;
    case 0x255D:fh(d1Y,L,x0,d2X-x0+L);fh(d2Y,L,x0,d1X-x0+L);fv(d2X,L,y0,d2Y-y0+L);fv(d1X,L,y0,d1Y-y0+L);break;
    case 0x2560:fv(d1X,L);fv(d2X,L);fh(d1Y,L,d2X,xR-d2X);fh(d2Y,L,d2X,xR-d2X);break;
    case 0x2563:fv(d1X,L);fv(d2X,L);fh(d1Y,L,x0,d1X-x0+L);fh(d2Y,L,x0,d1X-x0+L);break;
    case 0x2566:fh(d1Y,L);fh(d2Y,L);fv(d1X,L,d2Y,yB-d2Y);fv(d2X,L,d2Y,yB-d2Y);break;
    case 0x2569:fh(d1Y,L);fh(d2Y,L);fv(d1X,L,y0,d1Y-y0+L);fv(d2X,L,y0,d1Y-y0+L);break;
    case 0x256C:fh(d1Y,L);fh(d2Y,L);fv(d1X,L);fv(d2X,L);break;
    case 0x256D:fh(lhY,L,lvX,xR-lvX);fv(lvX,L,lhY,yB-lhY);break;
    case 0x256E:fh(lhY,L,x0,lvX-x0+L);fv(lvX,L,lhY,yB-lhY);break;
    case 0x256F:fh(lhY,L,x0,lvX-x0+L);fv(lvX,L,y0,lhY-y0+L);break;
    case 0x2570:fh(lhY,L,lvX,xR-lvX);fv(lvX,L,y0,lhY-y0+L);break;
  }
}
`;

const blockCharPatch = {
    name: 'block-char-patch',
    setup(build) {
        build.onEnd(() => {
            let code = readFileSync('main.js', 'utf-8');
            const before = code;

            // 1. Inject the helper functions at the top of the file (after the banner comment)
            code = code.replace(/^(\/\*[\s\S]*?\*\/\n)/, `$1${BLOCK_CHAR_FNS}`);

            // 2. Patch renderCellText: intercept fillText for block/box chars.
            //    Pattern: ...String.fromCodePoint(A.codepoint||32),this.ctx.fillText(charVar,xVar,yVar)
            //    We replace fillText with conditional calls to _drawBlockChar/_drawBoxChar.
            //    cellY = yVar - this.metrics.baseline (avoids capturing the minified var name for I)
            code = code.replace(
                /(String\.fromCodePoint\(A\.codepoint\|\|32\)),this\.ctx\.fillText\((\w+),(\w+),(\w+)\)/,
                (_, setChar, charVar, xVar, yVar) =>
                    `${setChar},(A.codepoint>=0x2580&&A.codepoint<=0x259F` +
                    `?_drawBlockChar(this.ctx,A.codepoint,${xVar},${yVar}-this.metrics.baseline,this.metrics.width*A.width,this.metrics.height)` +
                    `:A.codepoint>=0x2500&&A.codepoint<=0x2570` +
                    `?_drawBoxChar(this.ctx,A.codepoint,${xVar},${yVar}-this.metrics.baseline,this.metrics.width*A.width,this.metrics.height,this.ctx.getTransform().a||1,this.ctx.getTransform().d||1)` +
                    `:this.ctx.fillText(${charVar},${xVar},${yVar}))`
            );

            if (code === before) {
                console.warn('[block-char-patch] WARNING: pattern not found, patch skipped');
            } else {
                console.log('[block-char-patch] Applied block/box character patch to ghostty-web.');
                writeFileSync('main.js', code);
            }
        });
    },
};

// Patch ghostty-web's measureFont: increase cell height padding +2 → +6
// so descenders (g, y, p, …) are not clipped at the bottom of each row.
const lineHeightPatch = {
    name: 'line-height-patch',
    setup(build) {
        build.onEnd(() => {
            let code = readFileSync('main.js', 'utf-8');
            const before = code;
            code = code.replace(
                /(actualBoundingBoxDescent[^;]{0,120}?Math\.ceil\([^)]+\))\+2(?=,[^;]+;return\{width:)/,
                '$1+6'
            );
            if (code === before) {
                console.warn('[line-height-patch] WARNING: pattern not found, patch skipped');
            } else {
                console.log('[line-height-patch] Cell height padding +2 → +6');
                writeFileSync('main.js', code);
            }
        });
    },
};

const banner = `/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
`;

const prod = (process.argv[2] === 'production');

esbuild.build({
    banner: { js: banner },
    entryPoints: ['main.ts'],
    bundle: true,
    external: [
        'obsidian',
        'electron',
        'node-pty-prebuilt-multiarch', // native addon – loaded at runtime via require()
        ...builtinModules,
    ],
    format: 'cjs',
    target: 'es2022',
    plugins: [blockCharPatch, lineHeightPatch],
    logLevel: 'info',
    loader: { '.py': 'text' },
    sourcemap: prod ? false : 'inline',
    treeShaking: true,
    outfile: 'main.js',
    minify: prod,
}).catch(() => process.exit(1));