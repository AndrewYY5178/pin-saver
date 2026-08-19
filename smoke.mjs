// 零依赖冒烟测试：用 node:vm 加载 src，对核心纯函数（URL 还原 / 命名 / 视频选择 / zip 生成）做断言。
// 用法：node smoke.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { crc32 as zlibCrc32 } from 'node:zlib';
import vm from 'node:vm';

const src = readFileSync(new URL('./src/pin-saver.user.js', import.meta.url), 'utf8');

// ---- 最小 DOM mock（只保证 init() 不炸，交互函数不参与测试）----
function makeEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    style: {},
    innerHTML: '',
    textContent: '',
    disabled: false,
    addEventListener() {},
    appendChild() {},
    remove() {},
    click() {},
    closest() { return null; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
  };
}

const H2 = 'fedcba9876543210fedcba9876543210';
const H3 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const gmStore = { psaver_downloaded: [H2] };   // 模拟「已下载过 H2 这张图」的持久记录
let fakeImgs = [];                              // 收集器看到的目标图片列表（测试时注入）
let aClicks = 0;                                // a[download] 点击计数

const context = vm.createContext({
  console,
  window: {},
  document: {
    body: makeEl('body'),
    createElement: (tag) => {
      const el = makeEl(tag);
      if (tag === 'a') el.click = () => { aClicks++; };
      return el;
    },
    getElementById: () => null,
    querySelectorAll: () => fakeImgs,
  },
  location: { pathname: '/search/pins/', origin: 'https://www.pinterest.com' },
  GM: {
    xmlHttpRequest() { throw new Error('GM unavailable in smoke'); },   // 立即失败：翻译走 GM 分支快速 reject
    getValue: (k, def) => (k in gmStore ? gmStore[k] : def),
    setValue: (k, v) => { gmStore[k] = v; },
  },
  MutationObserver: class { observe() {} },
  setTimeout,
  setInterval: () => 0,   // no-op：避免 event loop 常驻
  clearTimeout: () => {},
  TextEncoder,
  fetch: () => Promise.reject(new Error('fetch not available in smoke')),
  AbortController,
  URL: { createObjectURL: () => 'blob:mock', revokeObjectURL() {} },
  Blob,
});
context.window.window = context.window;

vm.runInContext(src, context);

const T = context.window.__pinSaver;
if (!T) throw new Error('脚本未挂载 window.__pinSaver 测试出口');

// ---- 断言工具 ----
let passed = 0, failed = 0;
function eq(name, actual, expected) {
  if (actual === expected) { passed++; console.log('  pass  ' + name); }
  else {
    failed++;
    console.log('  FAIL  ' + name + '\n        expected: ' + expected + '\n        actual:   ' + actual);
  }
}
function ok(name, cond) {
  if (cond) { passed++; console.log('  pass  ' + name); }
  else { failed++; console.log('  FAIL  ' + name); }
}

const H = '0123456789abcdef0123456789abcdef';
const ORIG = 'https://i.pinimg.com/originals/ab/cd/ef/' + H + '.jpg';

console.log('URL 还原:');
eq('236x → originals',
  T.toOriginalUrl('https://i.pinimg.com/236x/ab/cd/ef/' + H + '.jpg'), ORIG);
eq('736x → originals',
  T.toOriginalUrl('https://i.pinimg.com/736x/ab/cd/ef/' + H + '.png'), ORIG.replace('.jpg', '.png'));
eq('600x315 → originals',
  T.toOriginalUrl('https://i.pinimg.com/600x315/ab/cd/ef/' + H + '.jpg'), ORIG);
eq('originals 幂等', T.toOriginalUrl(ORIG), ORIG);
eq('视频海报幂等',
  T.toOriginalUrl('https://i.pinimg.com/videos/thumbnails/originals/ab/cd/ef/' + H + '.0000000.jpg'),
  'https://i.pinimg.com/videos/thumbnails/originals/ab/cd/ef/' + H + '.0000000.jpg');
eq('去查询串',
  T.toOriginalUrl('https://i.pinimg.com/474x/ab/cd/ef/' + H + '.jpg?x=1'), ORIG);
eq('avatar 无尺寸段原样返回',
  T.toOriginalUrl('https://i.pinimg.com/avatars/some_user_60x60.jpg'),
  'https://i.pinimg.com/avatars/some_user_60x60.jpg');

console.log('srcset 候选选取:');
function fakeImg(src, srcset) {
  return { src: src, getAttribute: function (n) { return n === 'srcset' ? srcset : null; } };
}
eq('srcset 直出 originals 优先命中',
  T.pickBestUrl(fakeImg('https://i.pinimg.com/236x/ab/cd/ef/' + H + '.jpg',
    'https://i.pinimg.com/236x/ab/cd/ef/' + H + '.jpg 236w, '
    + 'https://i.pinimg.com/474x/ab/cd/ef/' + H + '.jpg 474w, '
    + ORIG + ' 1200w')),
  ORIG);
eq('无 originals 时取最大尺寸还原',
  T.pickBestUrl(fakeImg('https://i.pinimg.com/236x/ab/cd/ef/' + H + '.jpg',
    'https://i.pinimg.com/236x/ab/cd/ef/' + H + '.jpg 236w, '
    + 'https://i.pinimg.com/736x/ab/cd/ef/' + H + '.jpg 736w')),
  ORIG);

console.log('hash / 命名:');
eq('hashOf 32hex', T.hashOf(ORIG), H);
eq('sanitize 非法字符', T.sanitize('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
eq('sanitize 空 → untitled', T.sanitize('  '), 'untitled');
ok('sanitize 截断 60', T.sanitize('x'.repeat(100)).length === 60);
eq('fileStem 序号+标题',
  T.fileStem({ id: '123456', title: '客厅/极简?设计', origUrl: ORIG }, 0, '客厅_极简_设计'),
  '001-客厅_极简_设计');
eq('fileStem 无标题 → 图',
  T.fileStem({ id: null, title: null, origUrl: ORIG }, 4, ''),
  '005-图');

console.log('uniq 重名去重:');
var used1 = {};
eq('uniq 首次不重复', T.uniq(used1, '001-图.jpg'), '001-图.jpg');
eq('uniq 第二次加 -2', T.uniq(used1, '001-图.jpg'), '001-图-2.jpg');
eq('uniq 第三次加 -3 且扩展名保留', T.uniq(used1, '001-图.jpg'), '001-图-3.jpg');

console.log('主题系统:');
ok('THEMES 含 6 套主题且默认 indigo 在列',
  T.THEMES && Object.keys(T.THEMES).length === 6 && !!T.THEMES.indigo);
ok('每套主题 token 齐全', Object.keys(T.THEMES).every(function (k) {
  var th = T.THEMES[k];
  return th.name && th.paper && th.ink && th.inkLight && th.rule
    && th.accent && th.onAccent && th.fab && th.fabText && Array.isArray(th.swatches);
}));
ok('theme() 默认返回 indigo', T.theme() === T.THEMES.indigo);

console.log('双语标题（smoke 无网络，验证失败回退路径）:');
eq('translateToEn 网络不可用返回 null', await T.translateToEn('客厅设计'), null);
eq('titleFor 无中文不翻译', await T.titleFor({ title: 'Living room ideas' }), 'Living room ideas');
eq('titleFor 中文但翻译失败回退单语', await T.titleFor({ title: '客厅设计' }), '客厅设计');
eq('titleFor 空标题返回空串', await T.titleFor({ title: null }), '');

console.log('视频选择:');
eq('720P MP4 优先',
  T.getBestVideo({
    V_720P: { url: 'https://v.pinimg.com/videos/mc/720p/x/y/z/h.mp4' },
    V_HLSV4: { url: 'https://v.pinimg.com/videos/hls/x/y/z/h.m3u8' },
    V_480P: { url: 'https://v.pinimg.com/videos/mc/480p/x/y/z/h.mp4' },
  }).key, 'V_720P');
eq('同分辨率 MP4 优先于 HLS',
  T.getBestVideo({
    V_HLSV3: { url: 'https://v.pinimg.com/videos/hls/x/y/z/h.m3u8' },
    V_480P: { url: 'https://v.pinimg.com/videos/mc/480p/x/y/z/h.mp4' },
  }).key, 'V_480P');
ok('placeholder 条目被过滤',
  T.getBestVideo({
    V_720P: { url: '{placeholder}' },
    V_480P: { url: 'https://v.pinimg.com/videos/mc/480p/x/y/z/h.mp4' },
  }).key === 'V_480P');
ok('空列表返回 null', T.getBestVideo(null) === null);

console.log('海报 hash 提取:');
const pp = T.posterPath('https://i.pinimg.com/videos/thumbnails/originals/ab/cd/ef/' + H + '.0000000.jpg');
ok('posterPath x/y/z/hash',
  pp && pp.x === 'ab' && pp.y === 'cd' && pp.z === 'ef' && pp.hash === H);

console.log('去重:');
eq('labelMeansSaved 英文 Saved', T.labelMeansSaved('Saved'), true);
eq('labelMeansSaved 中文 已保存', T.labelMeansSaved('已保存'), true);
eq('labelMeansSaved 未保存 Save', T.labelMeansSaved('Save'), false);
eq('labelMeansSaved 空值', T.labelMeansSaved(null), false);

function savedCard(label) {
  const btn = { getAttribute: () => label };
  const card = { querySelectorAll: () => [btn], querySelector: () => null };
  return { closest: () => card, parentElement: null };
}
ok('isSavedCard 识别已收藏卡片', T.isSavedCard(savedCard('Saved')));
ok('isSavedCard 未收藏卡片', !T.isSavedCard(savedCard('Save')));

ok('loadDlSet 解析已下载记录', (await T.loadDlSet()).has(H2));   // v0.2.2：loadDlSet 改为 async（GM.getValue 是 Promise）

function pinImg(hash, label) {
  const btn = { getAttribute: () => label };
  const card = { querySelectorAll: () => [btn], querySelector: () => null };
  return {
    src: 'https://i.pinimg.com/236x/ab/cd/ef/' + hash + '.jpg',
    currentSrc: '',
    alt: '测试图',
    getBoundingClientRect: () => ({ width: 500 }),
    getAttribute: (n) => (n === 'srcset' ? '' : null),
    closest: (sel) => (sel.indexOf('a[href') !== -1 ? null : card),
  };
}
const stats0 = T.getDedupStats();
fakeImgs = [pinImg(H, 'Saved')];
eq('collectPins 跳过已收藏（added=0）', T.collectPins(), 0);
ok('skipSaved 计数 +1', T.getDedupStats().skippedSaved === stats0.skippedSaved + 1);
fakeImgs = [pinImg(H2, 'Save')];
eq('collectPins 跳过已下载（added=0）', T.collectPins(), 0);
ok('skipDownloaded 计数 +1', T.getDedupStats().skippedDownloaded === stats0.skippedDownloaded + 1);
fakeImgs = [pinImg(H3, 'Save')];
eq('collectPins 正常收集（added=1）', T.collectPins(), 1);

T.flushDlSet();
ok('flushDlSet 写入 GM 存储为数组', Array.isArray(gmStore.psaver_downloaded));
ok('flushDlSet 保留已下载 key', gmStore.psaver_downloaded.indexOf(H2) !== -1);

console.log('下载:');
const clicksBefore = aClicks;
T.downloadBlob(new Blob(['x']), 't.zip');
ok('downloadBlob 触发 a[download] 点击', aClicks === clicksBefore + 1);

console.log('zip 生成（v0.2.8 自写 STORE 生成器）:');
const toBuf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
const bytes1 = vm.runInContext('new Uint8Array([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15])', context);
const bytes2 = vm.runInContext('new TextEncoder().encode("hello 世界 \\u0000\\n")', context);
eq('crc32Of 与 node zlib.crc32 一致', T.crc32Of(bytes1), zlibCrc32(toBuf(bytes1)));
const zipBytes = await T.makeZip([
  { name: 'images/测试-中文名.bin', data: bytes1 },
  { name: '说明.txt', data: bytes2 },
]);
ok('zip 以 PK\\x03\\x04 开头',
  zipBytes[0] === 0x50 && zipBytes[1] === 0x4b && zipBytes[2] === 3 && zipBytes[3] === 4);
ok('zip 以 EOCD(PK\\x05\\x06) 结尾',
  zipBytes[zipBytes.length - 22] === 0x50 && zipBytes[zipBytes.length - 21] === 0x4b
  && zipBytes[zipBytes.length - 20] === 5 && zipBytes[zipBytes.length - 19] === 6);
{
  // 写盘后用系统 unzip -t 做全格式校验（含 CRC 与目录结构）
  const tmpZip = '/tmp/psaver-smoke.zip';
  writeFileSync(tmpZip, toBuf(zipBytes));
  let unzipOk = true, unzipOut = '';
  try { unzipOut = execSync('unzip -t ' + tmpZip, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { unzipOk = false; unzipOut = String(e && e.stdout || '') + String(e && e.stderr || ''); }
  ok('系统 unzip -t 校验通过', unzipOk);
  if (!unzipOk) console.log('  unzip 输出: ' + unzipOut.trim().slice(0, 400));
  ok('两个文件均校验 OK',
    unzipOk && unzipOut.indexOf('No errors detected') !== -1 && (unzipOut.match(/ OK/g) || []).length === 2);
  // 中文名解码：unzip 是否支持 -O UTF-8 因系统而异，支持时验证 UTF-8 flag 生效
  try {
    const uo = execSync('unzip -O UTF-8 -t ' + tmpZip, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    ok('中文文件名按 UTF-8 正确解码',
      uo.indexOf('images/测试-中文名.bin') !== -1 && uo.indexOf('说明.txt') !== -1);
  } catch (e) { console.log('  （本机 unzip 不支持 -O UTF-8，跳过中文名解码断言）'); }
}

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
