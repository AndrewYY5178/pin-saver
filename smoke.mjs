// 零依赖冒烟测试：用 node:vm 加载 src，对核心纯函数（URL 还原 / 命名 / 视频选择）做断言。
// 用法：node smoke.mjs
import { readFileSync } from 'node:fs';
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
    xmlHttpRequest() {},
    getValue: (k, def) => (k in gmStore ? gmStore[k] : def),
    setValue: (k, v) => { gmStore[k] = v; },
  },
  MutationObserver: class { observe() {} },
  setTimeout,
  setInterval: () => 0,   // no-op：避免 event loop 常驻
  clearTimeout: () => {},
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
eq('fileStem 序号+id+标题',
  T.fileStem({ id: '123456', title: '客厅/极简?设计', origUrl: ORIG }, 0),
  '001-123456-客厅_极简_设计');
eq('fileStem 无 id 用 hash 前 8 位',
  T.fileStem({ id: null, title: null, origUrl: ORIG }, 4),
  '005-01234567-untitled');

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

ok('loadDlSet 解析已下载记录', T.loadDlSet().has(H2));

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

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
