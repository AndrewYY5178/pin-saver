// 生成 dist/pin-saver.user.js 成品。
// 用法：node build.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const src = await readFile(new URL('src/pin-saver.user.js', root), 'utf8');

if (!src.includes('/*__JSZIP_SOURCE__*/')) {
  throw new Error('src 里找不到 /*__JSZIP_SOURCE__*/ 占位符');
}

// v0.2.8：不再使用 JSZip（自写 STORE zip 生成器，真实 TM 沙箱里 JSZip 会静默挂起），占位符清空。
// vendor/jszip.min.js 保留作历史参考，不再内嵌。
const out = src.replace('/*__JSZIP_SOURCE__*/', '');

await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/pin-saver.user.js', root), out, 'utf8');
console.log('已生成 dist/pin-saver.user.js，长度', out.length, '字符');
