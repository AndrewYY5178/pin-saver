// 把 src/pin-saver.user.js 与 vendor/jszip.min.js 合并为 dist/pin-saver.user.js 成品。
// 用法：node build.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const src = await readFile(new URL('src/pin-saver.user.js', root), 'utf8');
const vendor = await readFile(new URL('vendor/jszip.min.js', root), 'utf8');

if (!src.includes('/*__JSZIP_SOURCE__*/')) {
  throw new Error('src 里找不到 /*__JSZIP_SOURCE__*/ 占位符');
}

// userscript 由脚本管理器以纯文本注入（不经 HTML 解析），vendor 直接原文拼接即可。
// JSZip 是 UMD 单行 minified，运行时会挂到脚本沙盒的全局（self），脚本内 new JSZip() 直接可用。
const out = src.replace('/*__JSZIP_SOURCE__*/', vendor);

await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/pin-saver.user.js', root), out, 'utf8');
console.log('已生成 dist/pin-saver.user.js，长度', out.length, '字符');
