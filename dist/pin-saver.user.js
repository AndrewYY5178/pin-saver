// ==UserScript==
// @name         Pinterest 批量保存素材
// @namespace    pin-saver
// @version      0.3.0
// @description  批量保存 Pinterest 图片/GIF/视频（原图不压缩），收集后打包为单个 Zip。登录/未登录均可使用；可跳过已收藏与已下载过的素材。
// @match        https://www.pinterest.com/*
// @match        https://pinterest.com/*
// @include      /^https?:\/\/([a-z0-9-]+\.)*pinterest\.[a-z]{2,3}(\.[a-z]{2})?\/.*$/
// @grant        GM.xmlHttpRequest
// @grant        GM.setValue
// @grant        GM.getValue
// @connect      i.pinimg.com
// @connect      v.pinimg.com
// @connect      *.pinimg.com
// @connect      api-edge.cognitive.microsofttranslator.com
// @connect      api.mymemory.translated.net
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ===== [CONFIG] 配置与常量 ===== */
  var CFG = {
    maxCollect: 300,     // 单次收集上限（内存考虑，超大可调小分两次打包）
    scrollStepMs: 800,   // 滚动步进间隔
    scrollMaxTries: 12,  // 页面高度连续不变 N 轮后自动停止
    concurrency: 4,      // 打包时并发下载数
    apiFailLimit: 3,     // 内部 API 失败 N 次后本会话熔断
    apiTimeoutMs: 3000,
    dlHistLimit: 5000,   // 本地「已下载」记录条数上限（GM 存储容量安全）
    zipWatchdogMs: 10 * 60 * 1000,  // 打包总时长看门狗：超时强制恢复 UI（防网络挂起卡死）
  };

  // 多候选选择器：未登录门控卡片 / 登录态新版 / 登录态旧版 / 通用兜底
  var PIN_IMG_SELECTORS = [
    '[data-test-id="gated-pin-image"] img',  // 未登录门控卡片（实测 2026-08）
    'div[data-test-id="pin-rep"] img',       // 登录态新版卡片
    '[data-test-id="pin"] img',              // 登录态旧版卡片
    'article img[srcset]',                   // 兜底
  ];

  /* ===== [STATE] 状态单例 ===== */
  var S = {
    pins: new Map(),        // key -> PinItem（Map 保插入序，编号按序）
    state: 'idle',          // idle | collecting | downloading
    stopCollect: false,
    panelOpen: false,
    apiFails: 0,
    skippedSegments: 0,
    cfg: { skipSaved: true, skipDownloaded: true },  // 面板两个去重开关（本次会话生效）
    theme: 'indigo',         // v0.3.0：主题 key（THEMES），GM 存储持久化
    dlSet: new Set(),       // 本地已下载 key 集合（GM 存储持久化，跨会话；init 时异步加载）
    skippedKeys: new Map(), // key -> 'saved'|'dl'（已判跳过的不重复计数）
    skippedSaved: 0,
    skippedDownloaded: 0,
    log: '',
    logHistory: [],   // v0.2.5：日志历史（带时间戳），面板可查 + 一键复制，摆脱 Console 噪音
    progress: '',
  };

  /* ===== [DEDUP] 去重：已收藏（页面标记）与已下载（本地 GM 存储记录） ===== */
  // 保存按钮 aria-label 判读：英文 "Saved" / 中文「已保存」
  function labelMeansSaved(label) {
    var s = String(label || '').toLowerCase();
    return s.indexOf('saved') !== -1 || s.indexOf('已保存') !== -1;
  }

  // 卡片内任一 aria-label 含 Saved 即视为已收藏（仅登录态有该按钮；检测不到当未收藏，宁可多收）
  function isSavedCard(img) {
    var card = img.closest('[data-test-id="pin"]') || img.closest('article') || img.parentElement;
    if (!card) return false;
    var els;
    try { els = card.querySelectorAll('[aria-label]'); } catch (e) { return false; }
    for (var i = 0; i < els.length; i++) {
      if (labelMeansSaved(els[i].getAttribute('aria-label'))) return true;
    }
    return false;
  }

  // 已下载记录：GM 存储持久化（跨会话），条数上限 CFG.dlHistLimit
  // 注意：GM.getValue 返回 Promise，必须 await（v0.2.2 修复——此前读回恒为空，跨会话去重失效）
  async function loadDlSet() {
    try {
      var v = (typeof GM !== 'undefined' && GM.getValue)
        ? await GM.getValue('psaver_downloaded', [])
        : [];
      return new Set(Array.isArray(v) ? v : []);
    } catch (e) { return new Set(); }
  }

  function flushDlSet() {
    try {
      if (typeof GM !== 'undefined' && GM.setValue) {
        var arr = Array.from(S.dlSet);
        GM.setValue('psaver_downloaded', arr.length > CFG.dlHistLimit ? arr.slice(arr.length - CFG.dlHistLimit) : arr);
      }
    } catch (e) { /* 存储不可用时本次会话内存去重仍有效 */ }
  }

  /* ===== [URL] 原图 URL 还原与候选选取 ===== */
  // Pinterest 压缩图: i.pinimg.com/236x|474x|736x|750x/xx/yy/zz/hash.ext
  // 原始高清图:     i.pinimg.com/originals/xx/yy/zz/hash.ext（同一 hash，替换尺寸段即可）
  function toOriginalUrl(u) {
    if (!u) return null;
    u = String(u).replace(/^\/\//, 'https://').split('?')[0];
    if (u.indexOf('/originals/') !== -1) return u;   // 已是原图（含视频海报 originals）
    return u
      .replace(/\/\d+x\d+\//, '/originals/')
      .replace(/\/\d+x\//, '/originals/');
  }

  function srcsetCandidates(img) {
    var out = [];
    if (img.src) out.push({ url: img.src, w: 0 });
    var ss = (img.getAttribute('srcset') || '').split(',');
    for (var i = 0; i < ss.length; i++) {
      var parts = ss[i].trim().split(/\s+/);
      var w = parts[1] ? parseInt(parts[1].replace(/\D/g, ''), 10) || 0 : 0;
      if (parts[0]) out.push({ url: parts[0], w: w });
    }
    return out;
  }

  // 优先取已含 originals 的候选（未登录 srcset 实测直出原图），否则取最大尺寸再还原
  function pickBestUrl(img) {
    var cands = srcsetCandidates(img);
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].url.indexOf('/originals/') !== -1) return cands[i].url;
    }
    var max = cands[0];
    for (var j = 1; j < cands.length; j++) {
      if (cands[j].w > max.w) max = cands[j];
    }
    return max ? toOriginalUrl(max.url) : null;
  }

  // 原图 URL 的 hash 段（即 Pinterest 的 image_signature，天然唯一，用于去重与文件名）
  function hashOf(origUrl) {
    var m = String(origUrl || '').match(/\/([0-9a-f]{32}|[A-Za-z0-9_-]{16,})\.[a-z0-9]+$/i);
    return m ? m[1] : null;
  }

  function extOf(url) {
    var m = String(url || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    return m ? m[1] : 'jpg';
  }

  /* ===== [COLLECT] 收集器 ===== */
  function pinIdFromImg(img) {
    var a = img.closest('a[href*="/pin/"]');
    if (a) {
      var m = a.href.match(/\/pin\/(\d+)\//);
      if (m) return m[1];
    }
    return null;
  }

  function isVideoPin(img) {
    if ((img.src || '').indexOf('/videos/thumbnails/') !== -1) return true;
    if ((img.getAttribute('srcset') || '').indexOf('/videos/thumbnails/') !== -1) return true;
    var card = img.closest('[data-test-id]');
    return !!(card && card.querySelector('video'));
  }

  function extractFromImg(img) {
    // 过滤顶部栏小图 / 头像
    var rect = img.getBoundingClientRect();
    if (rect.width > 0 && rect.width < 100) return null;
    if ((img.src || '').indexOf('/avatars/') !== -1) return null;

    var best = pickBestUrl(img);
    // 还原后必然含 originals（avatar/logo 等无尺寸段的 URL 在这里被滤掉）
    if (!best || best.indexOf('pinimg.com') === -1 || best.indexOf('/originals/') === -1) return null;

    var id = pinIdFromImg(img);
    var hash = hashOf(best);
    var key = id || hash || best;
    if (!key) return null;

    var alt = (img.alt || '').trim();
    return {
      id: id,
      key: key,
      origUrl: best,                                   // 原图（视频 pin 为海报图）
      thumbUrl: img.currentSrc || img.src || null,     // 原图失败时回退缩略图
      title: alt && alt !== 'Pin 图' && alt.length <= 200 ? alt : null,
      isVideo: isVideoPin(img),
      videoList: null,                                 // 登录态 API 增强时填充
    };
  }

  function collectPins() {
    var added = 0;
    var isBoard = detectPageType() === 'board';   // 收藏夹页整页已收藏，强制不跳过已收藏
    for (var s = 0; s < PIN_IMG_SELECTORS.length; s++) {
      var els;
      try { els = document.querySelectorAll(PIN_IMG_SELECTORS[s]); } catch (e) { continue; }
      for (var i = 0; i < els.length; i++) {
        var item = extractFromImg(els[i]);
        if (!item || S.pins.has(item.key)) continue;
        // 已判跳过（同一 img 会被多个选择器重复命中，这里挡住不重复判断、不收集）
        if (S.skippedKeys.has(item.key)) {
          var why = S.skippedKeys.get(item.key);
          if ((why === 'saved' && S.cfg.skipSaved) || (why === 'dl' && S.cfg.skipDownloaded)) continue;
          S.skippedKeys.delete(item.key);   // 对应开关已关闭，允许重新收集
        }
        if (!isBoard && S.cfg.skipSaved && isSavedCard(els[i])) {
          S.skippedKeys.set(item.key, 'saved');
          S.skippedSaved++;
          continue;
        }
        if (S.cfg.skipDownloaded && S.dlSet.has(item.key)) {
          S.skippedKeys.set(item.key, 'dl');
          S.skippedDownloaded++;
          continue;
        }
        S.pins.set(item.key, item);
        added++;
      }
    }
    return added;
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  var S_observer = null;
  function watchDom() {
    if (S_observer) return;
    var debounced = debounce(function () { collectPins(); renderPanel(); }, 800);
    S_observer = new MutationObserver(debounced);
    S_observer.observe(document.body, { childList: true, subtree: true });
    // 懒加载图片渲染完成兜底轮询（收集期间与手动滚动时持续增量收集）
    setInterval(function () { collectPins(); renderPanel(); }, 1500);
  }

  /* ===== [SCROLL] 自动滚动收集 ===== */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function autoScroll() {
    S.stopCollect = false;
    var unchanged = 0, lastH = 0;
    while (!S.stopCollect && unchanged < CFG.scrollMaxTries && S.pins.size < CFG.maxCollect) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(CFG.scrollStepMs);
      collectPins();
      renderPanel();
      var h = document.body.scrollHeight;
      unchanged = h === lastH ? unchanged + 1 : 0;
      lastH = h;
    }
    if (S.pins.size >= CFG.maxCollect) log('已达收集上限 ' + CFG.maxCollect + ' 个');
    else if (!S.stopCollect) log('已滚动到底部，共收集 ' + S.pins.size + ' 个');
    setState('idle');
  }

  /* ===== [API] 登录态增强（失败静默降级 DOM，未登录必 403） ===== */
  // 带超时的 JSON 请求：AbortController 覆盖到 body 读取完成（旧版只覆盖响应头，body 卡住仍会挂起）
  async function fetchJsonWithTimeout(url, opts, ms) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms);
    try {
      var res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      if (!res.ok) throw new Error('status ' + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  // PinResource/get：拿标题与视频直链（videos.video_list）
  async function pinDetail(id) {
    if (S.apiFails >= CFG.apiFailLimit) return null;
    var data = JSON.stringify({ options: { id: id, field_set_key: 'detailed' }, context: {} });
    var url = location.origin + '/resource/PinResource/get/'
      + '?source_url=' + encodeURIComponent('/pin/' + id + '/')
      + '&data=' + encodeURIComponent(data)
      + '&_=' + Date.now();
    try {
      var j = await fetchJsonWithTimeout(url, {
        credentials: 'include',
        headers: { 'X-Pinterest-PWS-Handler': 'www/pin/' + id + '.js' },
      }, CFG.apiTimeoutMs);
      var pin = j.resource_response && j.resource_response.data;
      if (!pin) throw new Error('empty');
      return {
        title: ((pin.title || pin.grid_title || '').trim()) || null,
        origUrl: (pin.images && pin.images.orig && pin.images.orig.url) || null,
        videoList: (pin.videos && pin.videos.video_list) || null,
      };
    } catch (e) {
      S.apiFails++;
      if (S.apiFails >= CFG.apiFailLimit) log('内部 API 不可用，已切换纯页面数据模式');
      return null;
    }
  }

  // video_list 按分辨率取最高，同分辨率 MP4 直链优先于 HLS
  function getBestVideo(videoList) {
    if (!videoList) return null;
    var entries = [];
    for (var k in videoList) {
      var v = videoList[k];
      if (!v || typeof v !== 'object' || !v.url || v.url.indexOf('{placeholder}') !== -1) continue;
      entries.push({
        key: k,
        url: v.url,
        resNum: parseInt(String(k).replace(/\D/g, ''), 10) || 0,
        isHls: /\.m3u8($|\?)/.test(v.url),
      });
    }
    if (!entries.length) return null;
    entries.sort(function (a, b) {
      return (b.resNum - a.resNum) || (Number(a.isHls) - Number(b.isHls));
    });
    return entries[0];
  }

  /* ===== [DOWNLOAD] 下载器 ===== */
  // v0.2.2 关键加固：TM 的 timeout 在 Chrome MV3 / 旧版上不可靠（连接阶段挂起时 ontimeout 不触发），
  // 请求会永不回调 → Promise 永不 settle → 整个打包流程卡死（用户环境实测症状）。
  // 这里加 JS 层守卫定时器 + settled 标志 + abort()，保证任何情况下 Promise 都会 settle。
  function gmFetch(url) {
    return new Promise(function (resolve, reject) {
      var settled = false, req = null, guard = null;
      function finish(fn, arg) {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        if (req && req.abort) { try { req.abort(); } catch (e) {} }
        fn(arg);
      }
      guard = setTimeout(function () {
        finish(reject, new Error('GM 无响应（疑似网络挂起），已强制放弃'));
      }, 25000);
      try {
        req = GM.xmlHttpRequest({
          method: 'GET',
          url: url,
          responseType: 'arraybuffer',
          headers: { Referer: 'https://www.pinterest.com/' },
          timeout: 20000,
          onload: function (r) {
            if (r.status >= 200 && r.status < 300 && r.response) finish(resolve, r.response);
            else finish(reject, new Error('GM status ' + r.status));
          },
          onerror: function () { finish(reject, new Error('GM network error')); },
          ontimeout: function () { finish(reject, new Error('GM timeout')); },
        });
      } catch (e) { finish(reject, e); }
    });
  }

  // GM 优先（无 CORS 限制），失败回退页面 fetch（i.pinimg.com 实测对页面 Origin 放行）
  // v0.2.2：回退 fetch 加 AbortController 超时——此前无超时，body 卡住会永久挂起
  // v0.2.4：两条通道都失败时写 Console（含原因）——批量下载整体失败时可直接看出是 403/超时/网络
  // v0.2.7：返回 ArrayBuffer（归一为 Uint8Array）而不是 Blob——JSZip 读 Blob 走 FileReader，
  //         真实 TM 沙箱里 FileReader 读沙箱 Blob 会静默挂起（用户实测 zip 生成卡死），bytes 直传完全绕开。
  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x && x.buffer instanceof ArrayBuffer) return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength || x.buffer.byteLength);
    throw new Error('无法识别的二进制响应');
  }

  async function fetchBytes(url) {
    try {
      return toBytes(await gmFetch(url));
    } catch (e) {
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, 30000);
      try {
        var res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error('fetch status ' + res.status);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e2) {
        try { console.warn('[pin-saver] 下载失败 ' + String(url).slice(0, 70) + '：' + (e2 && e2.message || e2)); } catch (e3) {}
        throw e2;
      } finally { clearTimeout(t); }
    }
  }

  // HLS：解析 m3u8 → 逐片下载 → 按序二进制拼接（无需 ffmpeg）
  async function fetchM3u8AndSegments(m3u8Url) {
    var text = new TextDecoder('utf-8').decode(await fetchBytes(m3u8Url));
    var base = m3u8Url.slice(0, m3u8Url.lastIndexOf('/') + 1);
    var segments = [], initMap = null, seen = {};
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      var m = t.match(/^#EXT-X-MAP:URI="([^"]+)"/);
      if (m) { initMap = m[1]; continue; }
      if (t && t.charAt(0) !== '#' && !seen[t]) { seen[t] = true; segments.push(t); }
    }
    var urls = [];
    if (initMap) urls.push(new URL(initMap, base).href);
    for (var j = 0; j < segments.length; j++) urls.push(new URL(segments[j], base).href);
    var parts = [];
    var t0 = Date.now();
    for (var k = 0; k < urls.length; k++) {
      if (Date.now() - t0 > 90000) {
        S.skippedSegments += urls.length - k;
        throw new Error('HLS 分片总耗时超限，放弃剩余分片');
      }
      try { parts.push(await fetchBytes(urls[k])); }
      catch (e) { S.skippedSegments++; }
    }
    if (!parts.length) throw new Error('HLS 分片全部下载失败');
    var totalLen = 0;
    for (var p = 0; p < parts.length; p++) totalLen += parts[p].length;
    var merged = new Uint8Array(totalLen);
    var off = 0;
    for (var q = 0; q < parts.length; q++) { merged.set(parts[q], off); off += parts[q].length; }
    return { buf: merged, ext: initMap ? 'mp4' : 'ts' };
  }

  // 未登录拿不到视频直链时，按海报图 hash 猜测 mp4 直链（尽力而为）
  function posterPath(origUrl) {
    var m = String(origUrl || '').match(/\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{32})\.\d{1,8}\.(?:jpg|jpeg|png)$/i);
    return m ? { x: m[1], y: m[2], z: m[3], hash: m[4] } : null;
  }

  async function tryConstructMp4(origUrl) {
    var p = posterPath(origUrl);
    if (!p) return null;
    var ress = ['720p', '480p', '360p'];
    var t0 = Date.now();
    for (var i = 0; i < ress.length; i++) {
      if (Date.now() - t0 > 40000) return null;   // v0.2.2：总时限，避免三档探测放大挂起
      var url = 'https://v.pinimg.com/videos/mc/' + ress[i] + '/'
        + p.x + '/' + p.y + '/' + p.z + '/' + p.hash + '.mp4';
      try {
        var buf = await gmFetch(url);
        return { buf: toBytes(buf), ext: 'mp4' };
      } catch (e) { /* 尝试下一档 */ }
    }
    return null;
  }

  /* ===== [NAME] 文件命名 ===== */
  function sanitize(s) {
    var out = String(s || '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 60);
    return out || 'untitled';
  }

  // v0.3.0：「序号 + 标题」命名（去掉 hash/pin id 段，标题由调用方经 titleFor 预处理）
  function fileStem(item, idx, title) {
    var nnn = String(idx + 1).padStart(3, '0');
    return nnn + '-' + (title || '图');
  }

  // 重名去重：'001-图.jpg' 已存在时变 '001-图-2.jpg'（去掉哈希后不同图可能同标题）
  function uniq(used, name) {
    if (!used[name]) { used[name] = true; return name; }
    var dot = name.lastIndexOf('.');
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '';
    var n = 2;
    while (used[base + '-' + n + ext]) n++;
    var out = base + '-' + n + ext;
    used[out] = true;
    return out;
  }

  // v0.3.0 双语标题：中文标题自动补英文（MyMemory 免费接口），失败静默回退单语
  var trCache = {};   // 同一标题只翻译一次（存最终双语串）
  var trFails = 0;    // 连续失败 3 次后熔断，后续只留原标题
  var trWait = Promise.resolve();

  async function titleFor(item) {
    var t = sanitize(item.title || '');
    if (t === 'untitled') t = '';
    if (!t || trFails >= 3) return t;
    if (!/[一-鿿]/.test(t)) return t;          // 无中文不翻译（英文标题原样）
    if (trCache[t]) return trCache[t];
    var en = await translateToEn(t);
    if (en) {
      var out = t.slice(0, 28) + '-' + en.slice(0, 40);
      trCache[t] = out;
      return out;
    }
    return t;
  }

  // 翻译请求：GM.xmlHttpRequest 优先——Pinterest 页面 CSP 的 connect-src 白名单不含翻译域名，
  // 页面 fetch 直连会被 CSP 拦截（实测）；GM 请求从扩展上下文发出不受页面 CSP 限制。
  // 无 GM 环境回退页面 fetch（测试环境快速失败）。8s 超时 + 调用失败立即 settle。
  function trJson(url, method, body, contentType) {
    return new Promise(function (resolve, reject) {
      if (typeof GM !== 'undefined' && GM.xmlHttpRequest) {
        var settled = false, req = null;
        var guard = setTimeout(function () {
          if (settled) return; settled = true;
          try { if (req && req.abort) req.abort(); } catch (e) {}
          reject(new Error('翻译请求超时'));
        }, 8000);
        try {
          req = GM.xmlHttpRequest({
            method: method, url: url, data: body || undefined,
            headers: contentType ? { 'Content-Type': contentType } : undefined,
            timeout: 8000,
            onload: function (r) {
              if (settled) return; settled = true; clearTimeout(guard);
              if (r.status >= 200 && r.status < 300) {
                try { resolve(JSON.parse(r.responseText)); }
                catch (e) { reject(new Error('翻译响应解析失败')); }
              } else reject(new Error('翻译接口 status ' + r.status));
            },
            onerror: function () { if (!settled) { settled = true; clearTimeout(guard); reject(new Error('翻译网络错误')); } },
            ontimeout: function () { if (!settled) { settled = true; clearTimeout(guard); reject(new Error('翻译超时')); } },
          });
        } catch (e) { settled = true; clearTimeout(guard); reject(e); }
      } else {
        var ctrl = new AbortController();
        var t = setTimeout(function () { ctrl.abort(); }, 8000);
        fetch(url, {
          method: method,
          headers: contentType ? { 'Content-Type': contentType } : undefined,
          body: body || undefined,
          signal: ctrl.signal,
        }).then(function (res) {
          if (!res.ok) throw new Error('status ' + res.status);
          return res.json();
        }).then(function (j) { clearTimeout(t); resolve(j); },
          function (e) { clearTimeout(t); reject(e); });
      }
    });
  }

  // 微软 Edge 免费翻译接口（POST JSON）优先，MyMemory 兜底；
  // 请求间 300ms 节流 + 连续 3 次失败熔断（只留原标题）。失败不影响打包主流程。
  async function translateToEn(text) {
    trWait = trWait.then(function () { return sleep(300); });
    await trWait;
    var en = null;
    try {
      var j = await trJson(
        'https://api-edge.cognitive.microsofttranslator.com/translate?from=zh-Hans&to=en&api-version=3.0',
        'POST', JSON.stringify([{ Text: text }]), 'application/json');
      var m = j && j[0] && j[0].translations && j[0].translations[0] && j[0].translations[0].text;
      en = sanitize(String(m || '')).toLowerCase();
    } catch (e) { /* 落下一个接口 */ }
    if (!en || en === 'untitled') {
      try {
        var j2 = await trJson(
          'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=zh-CN|en',
          'GET', null, null);
        en = sanitize(String((j2 && j2.responseData && j2.responseData.translatedText) || '')).toLowerCase();
      } catch (e2) { /* 落单语回退 */ }
    }
    if (!en || en === 'untitled') {
      trFails++;
      if (trFails >= 3) { try { console.warn('[pin-saver] 翻译接口连续失败，已停用双语标题'); } catch (e0) {} }
      return null;
    }
    trFails = 0;
    return en;
  }

  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
      + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // 页面 a[download] 下载：在用户手势内触发 100% 可靠；GM_download 处理 blob URL 会存成 txt（弃用）
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  /* ===== [ZIP] 打包 ===== */
  // v0.2.8：自写 STORE zip 生成器，彻底弃用 JSZip——
  // 真实 TM 沙箱里 JSZip 的 generateAsync（流式/普通均实测）静默挂起，超时也救不回。
  // 这里纯 Uint8Array 拼接 + DataView 写头，逻辑全同步（大文件分段让出主线程），不存在可挂起的第三方异步管线。
  // CRC32 用 slice-by-4 查表（快 3-4 倍）；flag 0x0800 = 文件名按 UTF-8 解释（中文名正常）。
  var CRC_T = (function () {
    var T = [new Uint32Array(256)];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      T[0][n] = c >>> 0;
    }
    for (var i = 1; i < 4; i++) {
      T[i] = new Uint32Array(256);
      for (var j = 0; j < 256; j++) {
        var p = T[i - 1][j];
        T[i][j] = (p >>> 8) ^ T[0][p & 0xFF];
      }
    }
    return T;
  })();

  function crc32Step(u8, c) {   // slice-by-4，c 为中间状态（初值 0xFFFFFFFF，结果需取反）
    var i = 0, len = u8.length, end4 = len - (len & 3);
    for (; i < end4; i += 4) {
      c = CRC_T[3][(c ^ u8[i]) & 0xFF] ^ CRC_T[2][((c >>> 8) ^ u8[i + 1]) & 0xFF]
        ^ CRC_T[1][((c >>> 16) ^ u8[i + 2]) & 0xFF] ^ CRC_T[0][((c >>> 24) ^ u8[i + 3]) & 0xFF];
    }
    for (; i < len; i++) c = CRC_T[0][(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return c;
  }

  function crc32Of(u8) { return (crc32Step(u8, 0xFFFFFFFF) ^ 0xFFFFFFFF) >>> 0; }

  // 大文件每 8MB 让出一次主线程，避免长图 CRC 时页面无响应
  async function crc32Chunked(u8) {
    var c = 0xFFFFFFFF;
    for (var off = 0; off < u8.length; off += 8388608) {
      c = crc32Step(u8.subarray(off, Math.min(off + 8388608, u8.length)), c);
      await new Promise(function (r) { setTimeout(r, 0); });
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    return {
      time: d.getHours() << 11 | d.getMinutes() << 5 | Math.floor(d.getSeconds() / 2),
      date: (d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate(),
    };
  }

  // entries: [{ name, data(Uint8Array) }] → 完整 zip 字节（STORE 无压缩）
  async function makeZip(entries) {
    var enc = new TextEncoder();
    var names = entries.map(function (e) { return enc.encode(e.name); });
    var i, total = 0, cdSize = 0;
    for (i = 0; i < entries.length; i++) {
      total += 30 + names[i].length + entries[i].data.length;
      cdSize += 46 + names[i].length;
    }
    var out = new Uint8Array(total + cdSize + 22);
    var dv = new DataView(out.buffer);
    var dt = dosDateTime(new Date());
    var pos = 0, crcs = [], offsets = [];
    for (i = 0; i < entries.length; i++) {
      var data = entries[i].data, nb = names[i];
      var crc = await crc32Chunked(data);
      offsets.push(pos);   // central directory 里的「local header 偏移」= 本 header 起点
      crcs.push(crc);
      // local file header（30 字节固定）
      dv.setUint32(pos, 0x04034b50, true); pos += 4;
      dv.setUint16(pos, 20, true); pos += 2;            // version needed
      dv.setUint16(pos, 0x0800, true); pos += 2;        // flags：文件名按 UTF-8
      dv.setUint16(pos, 0, true); pos += 2;             // method：STORE
      dv.setUint16(pos, dt.time, true); pos += 2;
      dv.setUint16(pos, dt.date, true); pos += 2;
      dv.setUint32(pos, crc, true); pos += 4;
      dv.setUint32(pos, data.length, true); pos += 4;   // csize
      dv.setUint32(pos, data.length, true); pos += 4;   // usize
      dv.setUint16(pos, nb.length, true); pos += 2;
      dv.setUint16(pos, 0, true); pos += 2;             // extra len
      out.set(nb, pos); pos += nb.length;
      out.set(data, pos); pos += data.length;
      try { console.log('[pin-saver] zip 写入 ' + (i + 1) + '/' + entries.length + ' · ' + entries[i].name); } catch (e0) {}
    }
    var cdStart = pos;
    for (i = 0; i < entries.length; i++) {
      var nb2 = names[i];
      // central directory header（46 字节固定）
      dv.setUint32(pos, 0x02014b50, true); pos += 4;
      dv.setUint16(pos, 20, true); pos += 2;            // version made by
      dv.setUint16(pos, 20, true); pos += 2;            // version needed
      dv.setUint16(pos, 0x0800, true); pos += 2;
      dv.setUint16(pos, 0, true); pos += 2;
      dv.setUint16(pos, dt.time, true); pos += 2;
      dv.setUint16(pos, dt.date, true); pos += 2;
      dv.setUint32(pos, crcs[i], true); pos += 4;
      dv.setUint32(pos, entries[i].data.length, true); pos += 4;
      dv.setUint32(pos, entries[i].data.length, true); pos += 4;
      dv.setUint16(pos, nb2.length, true); pos += 2;
      dv.setUint16(pos, 0, true); pos += 2;             // extra len
      dv.setUint16(pos, 0, true); pos += 2;             // comment len
      dv.setUint16(pos, 0, true); pos += 2;             // disk number start
      dv.setUint16(pos, 0, true); pos += 2;             // internal attrs
      dv.setUint32(pos, 0, true); pos += 4;             // external attrs
      dv.setUint32(pos, offsets[i], true); pos += 4;    // local header offset
      out.set(nb2, pos); pos += nb2.length;
    }
    // end of central directory（22 字节固定）
    dv.setUint32(pos, 0x06054b50, true); pos += 4;
    dv.setUint16(pos, 0, true); pos += 2;
    dv.setUint16(pos, 0, true); pos += 2;
    dv.setUint16(pos, entries.length, true); pos += 2;
    dv.setUint16(pos, entries.length, true); pos += 2;
    dv.setUint32(pos, cdSize, true); pos += 4;
    dv.setUint32(pos, cdStart, true); pos += 4;
    dv.setUint16(pos, 0, true); pos += 2;
    return out;
  }

  // 单个 pin 的处理：API 增强 → 视频/图片分支 → 放入对应 zip 文件夹
  async function processItem(item, idx, folders, notes) {
    var detail = null;
    if (item.id && S.apiFails < CFG.apiFailLimit) detail = await pinDetail(item.id);
    var info = Object.assign({}, item);
    if (detail) {
      if (detail.title) info.title = detail.title;
      if (detail.origUrl) info.origUrl = detail.origUrl;
      info.videoList = detail.videoList;
    }
    var stem = fileStem(info, idx, await titleFor(info));

    if (info.isVideo) {
      // 1) 登录态 API 的 video_list；2) 海报 hash 构造直链；3) 封面兜底
      var got = null;
      if (info.videoList) {
        var best = getBestVideo(info.videoList);
        if (best) {
          try {
            got = best.isHls
              ? await fetchM3u8AndSegments(best.url)
              : { buf: await fetchBytes(best.url), ext: 'mp4' };
          } catch (e) { /* 落下一级 */ }
        }
      }
      if (!got && info.origUrl) got = await tryConstructMp4(info.origUrl);
      if (got) {
        folders.videos.file(stem + '.' + got.ext, got.buf);
        S.dlSet.add(item.key);
        return;
      }
      try {
        var cover = await fetchBytes(item.origUrl);
        folders.videos.file(stem + '_cover.' + extOf(item.origUrl), cover);
        S.dlSet.add(item.key);
        notes.push(stem + '：视频直链不可得（未登录平台限制），仅保存封面');
      } catch (e2) {
        notes.push(stem + '：视频与封面均下载失败');
      }
      return;
    }

    try {
      var bytes = await fetchBytes(info.origUrl);
      folders.images.file(stem + '.' + extOf(info.origUrl), bytes);
      S.dlSet.add(item.key);
    } catch (e) {
      if (item.thumbUrl && item.thumbUrl !== info.origUrl) {
        try {
          var tb = await fetchBytes(item.thumbUrl);
          folders.errors.file(stem + '_thumb.' + extOf(item.thumbUrl), tb);
          notes.push(stem + '：原图下载失败，已用页面缩略图替代');
          return;
        } catch (e2) { /* 落最后 */ }
      }
      notes.push(stem + '：下载失败（' + (e && e.message || e) + '）');
    }
  }

  async function saveZip() {
    setState('downloading');
    S.skippedSegments = 0;
    S.abortAll = false;
    // v0.2.2 看门狗：极端网络挂起时强制恢复 UI，杜绝「按钮永久变灰」；正常打包不受影响
    var watchdog = setTimeout(function () {
      S.abortAll = true;
      setState('idle');
      log('打包总时长超限（疑似网络挂起），已中止剩余项目，可重新点击打包');
    }, CFG.zipWatchdogMs);
    var entries = [];
    var used = {};   // v0.3.0：zip 内重名去重（同标题不同图）
    var folders = {   // 与旧 JSZip folder API 同形，processItem 不用改；file() 直接进 entries
      images: { file: function (n, d) { entries.push({ name: 'images/' + uniq(used, n), data: d }); } },
      videos: { file: function (n, d) { entries.push({ name: 'videos/' + uniq(used, n), data: d }); } },
      errors: { file: function (n, d) { entries.push({ name: 'error_thumbnails/' + uniq(used, n), data: d }); } },
    };
    var notes = [];
    var items = Array.from(S.pins.values());
    var total = items.length;
    var queue = items.slice();
    var done = 0;
    log('开始打包 ' + total + ' 张（并发 ' + Math.min(CFG.concurrency, 4) + '）…');
    S.progress = '下载 0/' + total;
    renderPanel();

    async function worker() {
      while (queue.length && !S.abortAll) {
        var item = queue.shift();
        var idx = items.indexOf(item);
        // v0.2.3/0.2.4：进度显示当前项的简短 URL 与类型，并写 Console——卡住时最后一行日志就是卡点
        var cur = (item.isVideo ? '[视频]' : '[图]') + String(item.origUrl || '').slice(0, 55);
        S.progress = '下载 ' + done + '/' + total + ' · ' + cur;
        renderPanel();
        try { console.log('[pin-saver] 开始下载 ' + (idx + 1) + '/' + total + ' · ' + cur); } catch (e0) {}
        try { await processItem(item, idx, folders, notes); }
        catch (e) { notes.push('第 ' + (idx + 1) + ' 项处理异常：' + (e && e.message || e)); }
        done++;
        S.progress = '下载 ' + done + '/' + total;
        renderPanel();
        try { console.log('[pin-saver] 完成 ' + (idx + 1) + '/' + total + ' · ' + cur); } catch (e0) {}
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(CFG.concurrency, 4); i++) workers.push(worker());
    await Promise.all(workers);

    if (S.skippedSegments) notes.push('HLS 有 ' + S.skippedSegments + ' 个分片被跳过（平台防盗链）');
    entries.push({
      name: '说明.txt',
      data: new TextEncoder().encode(
        'Pinterest 批量保存说明\n'
        + '生成时间: ' + new Date().toLocaleString() + '\n'
        + '共处理 ' + total + ' 个 pin\n'
        + '去重设置: 跳过已收藏=' + (S.cfg.skipSaved ? '开' : '关') + '，跳过已下载=' + (S.cfg.skipDownloaded ? '开' : '关') + '\n'
        + '提示: 「已收藏」检测依赖页面标记，未登录或页面改版时自动失效（宁可多收）。\n'
        + '出品: AndDream (github.com/AndrewYY5178/pin-saver)\n\n'
        + (notes.length
          ? '降级 / 失败记录:\n' + notes.map(function (n) { return '- ' + n; }).join('\n')
          : '全部成功，无降级项。')),
    });
    var name = 'pinterest-' + stamp().slice(0, 13) + '.zip';   // v0.3.0：pinterest-YYYYMMDD-HHMM.zip
    try {
      S.progress = '下载完成，生成 zip 中…';
      renderPanel();
      try { console.log('[pin-saver] 开始生成 zip（' + total + ' 个文件，自写 STORE 直写）…'); } catch (e0) {}
      // v0.2.8：自写生成器全同步逻辑（内部仅分块让出），不存在可挂起的环节；看门狗仍然兜底
      var zipBytes = await makeZip(entries);
      var blob = new Blob([zipBytes], { type: 'application/zip' });
      S.lastZip = { blob: blob, name: name };   // 「下载 zip」按钮兜底：点击时新建用户手势，必定触发
      flushDlSet();
      try { console.log('[pin-saver] zip 已生成，大小 ' + Math.round(blob.size / 104857.6) / 10 + ' MB'); } catch (e0) {}
      log('zip 已生成：' + name + (notes.length ? '（失败/降级 ' + notes.length + ' 项，详见 zip 内说明.txt）' : '')
        + '。若浏览器未弹出下载，点面板「下载 zip」按钮');
    } catch (e) {
      log('打包失败：' + (e && e.message || e));
    } finally {
      clearTimeout(watchdog);
      setState('idle');   // v0.2.2：任何情况（含异常）都恢复 UI，按钮不再永久变灰
    }
    // 自动下载放在 UI 恢复之后：长异步链末尾的 a.click 已无用户手势，被浏览器拦截也不影响（「下载 zip」按钮兜底）
    if (S.lastZip) downloadBlob(S.lastZip.blob, S.lastZip.name);
  }

  /* ===== [SINGLE] 详情页单张保存 ===== */
  async function saveSinglePin() {
    setState('downloading');
    S.progress = '处理中…';
    renderPanel();
    var m = location.pathname.match(/^\/pin\/(\d+)/);
    var id = m && m[1];
    try {
      // 取页面中最大的 pinimg 图片（详情主图）
      var imgs = Array.from(document.querySelectorAll('img')).filter(function (i) {
        return (i.src || '').indexOf('pinimg.com') !== -1 && i.getBoundingClientRect().width > 200;
      });
      var bestImg = null, bestW = 0;
      for (var i = 0; i < imgs.length; i++) {
        var w = imgs[i].getBoundingClientRect().width;
        if (w > bestW) { bestW = w; bestImg = imgs[i]; }
      }
      var item = bestImg ? extractFromImg(bestImg) : null;
      var detail = id ? await pinDetail(id) : null;

      if (detail && detail.videoList && getBestVideo(detail.videoList)) {
        var best = getBestVideo(detail.videoList);
        var got = best.isHls
          ? await fetchM3u8AndSegments(best.url)
          : { buf: await fetchBytes(best.url), ext: 'mp4' };
        downloadBlob(new Blob([got.buf]), sanitize(detail.title || ('pin-' + id)) + '.' + got.ext);
        S.dlSet.add(item ? item.key : ('pin-' + id));
        log('视频已保存');
      } else if (detail && detail.origUrl) {
        var b1 = await fetchBytes(detail.origUrl);
        downloadBlob(new Blob([b1]), sanitize(detail.title || ('pin-' + id)) + '.' + extOf(detail.origUrl));
        S.dlSet.add(item ? item.key : ('pin-' + id));
        log('图片已保存');
      } else if (item) {
        var b2 = await fetchBytes(item.origUrl);
        downloadBlob(new Blob([b2]), sanitize(item.title || ('pin-' + (id || ''))) + '.' + extOf(item.origUrl));
        S.dlSet.add(item.key);
        log('图片已保存');
      } else {
        log('未找到可保存的图片（页面可能未加载完成）');
      }
    } catch (e) {
      log('保存失败：' + (e && e.message || e));
    }
    flushDlSet();
    setState('idle');
  }

  /* ===== [PAGE] 页面类型识别 ===== */
  function detectPageType() {
    var p = location.pathname;
    if (/^\/pin\/\d+/.test(p)) return 'pin';
    if (/^\/search\/pins\//.test(p)) return 'search';
    if (/^\/[^/]+\/[^/]+\/?$/.test(p) && p.indexOf('/users/') !== 0) return 'board';
    if (p === '/' || p === '') return 'home';
    return 'other';
  }

  /* ===== [UI] 悬浮按钮与面板 ===== */
  // v0.3.0 主题系统：token 配色来自 anddream-brand 品牌目录，默认 Indigo 主线；
  // 面板右上角色点切换（每主题一组），选择经 GM 存储持久化。每主题只用 1 个强调色（克制）。
  var THEMES = {
    indigo: {
      name: 'Indigo 品牌主线', paper: '#FAFAF8', ink: '#111111', inkLight: '#55554E', rule: '#D9D9D0',
      accent: '#254E7A', onAccent: '#FFFFFF', fab: '#111111', fabText: '#FFFFFF',
      swatches: ['#254E7A', '#FAFAF8'],
    },
    'indigo-dark': {
      name: 'Indigo 深色版', paper: '#18181A', ink: '#E0DDD5', inkLight: '#8C8A85', rule: '#3A3A3C',
      accent: '#6BA0D6', onAccent: '#111111', fab: '#6BA0D6', fabText: '#111111',
      swatches: ['#6BA0D6', '#18181A'],
    },
    rose: {
      name: '奶油玫瑰', paper: '#F6F6F0', ink: '#39393A', inkLight: '#7A746C', rule: '#E3E0D5',
      accent: '#C94C74', onAccent: '#FFFFFF', fab: '#39393A', fabText: '#FFFFFF',
      swatches: ['#C94C74', '#F6F6F0'],
    },
    deepsea: {
      name: '深海蓝', paper: '#F8F4E9', ink: '#1B2A33', inkLight: '#6A7A80', rule: '#E2DCC8',
      accent: '#00859F', onAccent: '#FFFFFF', fab: '#1B2A33', fabText: '#FFFFFF',
      swatches: ['#00859F', '#F8F4E9'],
    },
    copper: {
      name: '铜版余温', paper: '#FAF8F3', ink: '#141110', inkLight: '#8A7A68', rule: '#E4DCCD',
      accent: '#8B5A3C', onAccent: '#FFFFFF', fab: '#141110', fabText: '#FFFFFF',
      swatches: ['#8B5A3C', '#FAF8F3'],
    },
    night: {
      name: '暗夜 3D', paper: '#050508', ink: '#E8E6E1', inkLight: '#8A8A92', rule: '#26262E',
      accent: '#4499FF', onAccent: '#FFFFFF', fab: '#050508', fabText: '#E8E6E1', rainbow: true,
      swatches: ['#4499FF', '#050508'],
    },
  };

  function theme() { return THEMES[S.theme] || THEMES.indigo; }

  // 应用主题：移除重建 FAB 与面板（避免动态改大量内联样式），renderPanel 恢复显示状态
  function applyTheme(k) {
    if (!THEMES[k] || k === S.theme) return;
    S.theme = k;
    try { if (typeof GM !== 'undefined' && GM.setValue) GM.setValue('psaver_theme', k); } catch (e) {}
    var oldP = document.getElementById('psaver-panel');
    if (oldP) oldP.remove();
    ensurePanel();
    var oldF = document.getElementById('psaver-fab');
    if (oldF) oldF.remove();
    ensureFab();
    renderPanel();
  }

  // init 时异步读回主题选择（GM.getValue 是 Promise）
  function loadTheme() {
    if (typeof GM === 'undefined' || !GM.getValue) return;
    try {
      GM.getValue('psaver_theme', 'indigo').then(function (t) {
        applyTheme(t);
      }).catch(function () {});
    } catch (e) {}
  }

  function ensureFab() {
    if (document.getElementById('psaver-fab')) return;
    var t = theme();
    var fab = document.createElement('div');
    fab.id = 'psaver-fab';
    fab.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483646;background:' + t.fab + ';color:' + t.fabText + ';'
      + 'font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:10px 14px;'
      + 'border-radius:24px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.25);'
      + 'user-select:none;display:flex;align-items:center;gap:8px;overflow:hidden;';
    fab.innerHTML = '<span>保存</span>'
      + '<span id="psaver-count" style="display:none;background:' + t.accent + ';border-radius:10px;'
      + 'padding:1px 7px;font-size:11px;">0</span>'
      + (t.rainbow
        ? '<span style="position:absolute;left:0;right:0;bottom:0;height:3px;'
        + 'background:linear-gradient(90deg,#FF5544,#FF9944,#FFDD44,#44EE88,#4499FF,#9955FF,#FF55AA);"></span>'
        : '');
    fab.addEventListener('click', function () {
      S.panelOpen = !S.panelOpen;
      renderPanel();
    });
    document.body.appendChild(fab);
  }

  function ensurePanel() {
    if (document.getElementById('psaver-panel')) return;
    var t = theme();
    var el = document.createElement('div');
    el.id = 'psaver-panel';
    el.style.cssText =
      'position:fixed;right:16px;bottom:64px;z-index:2147483646;width:290px;background:' + t.paper + ';'
      + 'color:' + t.ink + ';font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
      + 'border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.18);padding:14px;display:none;';
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'
      + '<b>Pinterest 批量保存</b>'
      + '<span style="display:flex;align-items:center;gap:6px;">'
      + '<span id="psaver-ver" style="font-size:11px;color:' + t.inkLight + ';"></span>'
      + '<button id="psaver-theme-btn" title="切换主题" style="display:inline-flex;align-items:center;gap:4px;'
      + 'border:1px solid ' + t.rule + ';background:' + t.paper + ';color:' + t.ink
      + ';border-radius:6px;cursor:pointer;font:inherit;font-size:11px;padding:1px 6px;">'
      + '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + t.accent + ';"></span>主题</button>'
      + '<span id="psaver-close" style="cursor:pointer;color:' + t.inkLight + ';font-size:15px;line-height:1;">x</span>'
      + '</span>'
      + '</div>'
      + '<div id="psaver-themes" style="display:none;flex-wrap:wrap;gap:5px;margin-bottom:8px;"></div>'
      + '<div id="psaver-status" style="margin-bottom:6px;">已收集 0 个</div>'
      + '<div id="psaver-progress" style="margin-bottom:8px;color:' + t.inkLight + ';min-height:18px;"></div>'
      + '<div id="psaver-opts" style="margin-bottom:10px;font-size:12px;color:' + t.ink + ';">'
      + '<label style="display:flex;align-items:center;gap:6px;margin-bottom:4px;cursor:pointer;">'
      + '<input type="checkbox" id="psaver-opt-saved" style="margin:0;"> 跳过已收藏'
      + '<span id="psaver-opt-saved-note" style="display:none;color:' + t.inkLight + ';">（收藏夹页自动关闭）</span></label>'
      + '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;">'
      + '<input type="checkbox" id="psaver-opt-dl" style="margin:0;"> 跳过已下载过的</label>'
      + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
      + '<button id="psaver-start" style="flex:1;padding:7px 0;background:' + t.accent + ';color:' + t.onAccent
      + ';border:0;border-radius:8px;cursor:pointer;font:inherit;">开始收集</button>'
      + '<button id="psaver-stop" style="flex:1;padding:7px 0;background:' + t.paper + ';color:' + t.ink
      + ';border:1px solid ' + t.rule + ';border-radius:8px;cursor:pointer;font:inherit;display:none;">停止</button>'
      + '<button id="psaver-zip" style="flex:1;padding:7px 0;background:' + t.accent + ';color:' + t.onAccent
      + ';border:0;border-radius:8px;cursor:pointer;font:inherit;">打包下载 ZIP</button>'
      + '<button id="psaver-single" style="display:none;width:100%;padding:7px 0;background:' + t.accent
      + ';color:' + t.onAccent + ';border:0;border-radius:8px;cursor:pointer;font:inherit;">保存此 pin</button>'
      + '<button id="psaver-redl" style="display:none;width:100%;padding:9px 0;background:' + t.accent + ';color:'
      + t.onAccent + ';border:0;border-radius:8px;cursor:pointer;font:inherit;font-weight:bold;">下载 zip</button>'
      + '</div>'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">'
      + '<span style="font-size:11px;color:' + t.inkLight + ';">日志（最近 8 条）</span>'
      + '<button id="psaver-copylog" style="border:0;background:none;color:' + t.accent
      + ';cursor:pointer;font:inherit;font-size:11px;">复制全部日志</button>'
      + '</div>'
      + '<div id="psaver-log" style="color:' + t.inkLight + ';font-size:11px;white-space:pre-wrap;word-break:break-all;'
      + 'max-height:110px;overflow:auto;min-height:18px;"></div>'
      // v0.3.0 AndDream 水印：品牌衬线字体 + 克制的主题色小点，无 emoji
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">'
      + '<span style="font-size:11px;color:' + t.inkLight
      + ';font-family:\'Playfair Display\',\'Noto Serif SC\',Georgia,serif;letter-spacing:.5px;">AndDream 出品</span>'
      + '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + t.accent + ';"></span>'
      + '</div>';
    document.body.appendChild(el);

    // 主题选择器（v0.3.0）：点标题行「主题」按钮弹出，选中后收起；
    // 选项 pill = 色点对 + 名称，当前主题用强调色描边高亮
    var themesEl = el.querySelector('#psaver-themes');
    Object.keys(THEMES).forEach(function (k) {
      var th = THEMES[k];
      var g = document.createElement('span');
      g.title = th.name;
      g.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:3px 7px;border-radius:12px;'
        + 'cursor:pointer;font-size:11px;background:' + t.paper + ';color:' + t.ink + ';'
        + 'border:1px solid ' + (k === S.theme ? th.accent : t.rule) + ';';
      th.swatches.forEach(function (c) {
        var d = document.createElement('span');
        d.style.cssText = 'display:inline-block;width:7px;height:7px;border-radius:50%;background:' + c + ';';
        g.appendChild(d);
      });
      var lbl = document.createElement('span');
      lbl.textContent = th.name;
      g.appendChild(lbl);
      g.addEventListener('click', function () { applyTheme(k); });
      themesEl.appendChild(g);
    });
    el.querySelector('#psaver-theme-btn').addEventListener('click', function () {
      themesEl.style.display = themesEl.style.display === 'none' ? 'flex' : 'none';
    });

    el.querySelector('#psaver-close').addEventListener('click', function () {
      S.panelOpen = false;
      renderPanel();
    });
    el.querySelector('#psaver-start').addEventListener('click', function () {
      if (S.state !== 'idle') return;
      S.stopCollect = false;
      watchDom();
      setState('collecting');
      autoScroll();
    });
    el.querySelector('#psaver-stop').addEventListener('click', function () {
      S.stopCollect = true;
    });
    el.querySelector('#psaver-zip').addEventListener('click', function () {
      if (S.state === 'idle' && S.pins.size) saveZip();
    });
    el.querySelector('#psaver-single').addEventListener('click', function () {
      if (S.state === 'idle') saveSinglePin();
    });
    el.querySelector('#psaver-opt-saved').addEventListener('change', function () {
      S.cfg.skipSaved = this.checked;
      renderPanel();
    });
    el.querySelector('#psaver-opt-dl').addEventListener('change', function () {
      S.cfg.skipDownloaded = this.checked;
      renderPanel();
    });
    el.querySelector('#psaver-redl').addEventListener('click', function () {
      if (S.lastZip) downloadBlob(S.lastZip.blob, S.lastZip.name);   // 用户手势内触发，必定弹出下载
    });
    el.querySelector('#psaver-copylog').addEventListener('click', function () {
      var txt = S.logHistory.join('\n') || '（暂无日志）';
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(function () {
            log('日志已复制（' + S.logHistory.length + ' 条），请粘贴发给开发者');
          }, function () { log('复制失败，请手动选择日志区文字复制'); });
        } else { log('浏览器不支持剪贴板，请手动选择日志区文字复制'); }
      } catch (e) { log('复制失败，请手动选择日志区文字复制'); }
    });
    try {
      el.querySelector('#psaver-ver').textContent =
        'v' + scriptVersion() + (typeof GM_info !== 'undefined' && GM_info.version ? ' · TM ' + GM_info.version : '');
    } catch (e) {}
  }

  // v0.2.3：面板日志同时写 Console（[pin-saver] 前缀，F12 可查；Pinterest 页面的其他警告与此脚本无关）
  // v0.2.5：追加日志历史（带时间戳，最多 200 条），面板滚动区可查 + 一键复制
  function log(msg) {
    S.log = msg;
    try {
      S.logHistory.push(stamp().slice(-6) + ' ' + msg);
      if (S.logHistory.length > 200) S.logHistory.splice(0, S.logHistory.length - 200);
      console.log('[pin-saver] ' + msg);
    } catch (e) {}
    renderPanel();
  }

  function scriptVersion() {
    try {
      if (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) return GM_info.script.version;
    } catch (e) {}
    return '?';
  }

  function setState(s) {
    S.state = s;
    if (s === 'idle') S.progress = '';
    renderPanel();
  }

  function renderPanel() {
    try {
    var panel = document.getElementById('psaver-panel');
    if (!panel) return;
    panel.style.display = S.panelOpen ? 'block' : 'none';

    var count = document.getElementById('psaver-count');
    if (count) {
      count.style.display = S.pins.size ? 'inline-block' : 'none';
      count.textContent = S.pins.size;
    }

    document.getElementById('psaver-status').textContent =
      '已收集 ' + S.pins.size + ' 个' + (S.state === 'collecting' ? '（滚动中…）' : '')
      + (S.skippedSaved || S.skippedDownloaded
        ? '，跳过已收藏 ' + S.skippedSaved + '、已下载 ' + S.skippedDownloaded
        : '');
    document.getElementById('psaver-progress').textContent = S.progress;

    var isBoard = detectPageType() === 'board';
    var optSaved = document.getElementById('psaver-opt-saved');
    optSaved.disabled = isBoard;
    optSaved.checked = isBoard ? false : S.cfg.skipSaved;
    document.getElementById('psaver-opt-saved-note').style.display = isBoard ? 'inline' : 'none';
    document.getElementById('psaver-opt-dl').checked = S.cfg.skipDownloaded;

    document.getElementById('psaver-start').style.display =
      S.state === 'collecting' ? 'none' : 'inline-block';
    document.getElementById('psaver-stop').style.display =
      S.state === 'collecting' ? 'inline-block' : 'none';

    var zipBtn = document.getElementById('psaver-zip');
    zipBtn.disabled = S.state !== 'idle' || S.pins.size === 0;
    zipBtn.style.opacity = zipBtn.disabled ? '.5' : '1';

    var singleBtn = document.getElementById('psaver-single');
    singleBtn.style.display = detectPageType() === 'pin' ? 'block' : 'none';
    singleBtn.disabled = S.state !== 'idle';
    singleBtn.style.opacity = singleBtn.disabled ? '.5' : '1';

    var redlBtn = document.getElementById('psaver-redl');
    redlBtn.style.display = S.lastZip ? 'block' : 'none';   // v0.2.2：有 zip 就显示，不依赖 state

    document.getElementById('psaver-log').textContent = S.logHistory.slice(-8).join('\n') || '';
    } catch (e) { /* 面板渲染异常不阻断下载流程 */ }
  }

  /* ===== [INIT] 入口 ===== */
  var lastPath = location.pathname;

  function init() {
    loadDlSet().then(function (s) { S.dlSet = s; });   // GM 存储异步读回（v0.2.2 修复跨会话去重）
    loadTheme();                                       // v0.3.0：主题选择异步读回后重建 UI
    ensureFab();
    ensurePanel();
    renderPanel();
    // SPA 路由切换时清空收集列表（避免跨页面混包）
    setInterval(function () {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        if (S.state === 'idle' && S.pins.size) {
          S.pins.clear();
          log('页面已切换，已清空收集列表');
        }
        S.skippedKeys.clear();
        S.skippedSaved = 0;
        S.skippedDownloaded = 0;
        renderPanel();
      }
    }, 1000);
    // v0.2.3：Console 带版本号，便于确认脚本更新成功；面板底部日志同步显示在此（[pin-saver] 前缀）
    console.log('[pin-saver] loaded v' + scriptVersion()
      + (typeof GM_info !== 'undefined' && GM_info.version ? ' · TM ' + GM_info.version : ''));
  }

  // 测试/调试出口（smoke.mjs 用）
  if (typeof window !== 'undefined') {
    window.__pinSaver = {
      toOriginalUrl: toOriginalUrl,
      pickBestUrl: pickBestUrl,
      hashOf: hashOf,
      sanitize: sanitize,
      getBestVideo: getBestVideo,
      posterPath: posterPath,
      fileStem: fileStem,
      uniq: uniq,
      titleFor: titleFor,
      translateToEn: translateToEn,
      THEMES: THEMES,
      theme: theme,
      labelMeansSaved: labelMeansSaved,
      isSavedCard: isSavedCard,
      loadDlSet: loadDlSet,
      flushDlSet: flushDlSet,
      collectPins: collectPins,
      downloadBlob: downloadBlob,
      crc32Of: crc32Of,       // v0.2.8：smoke 与 node zlib.crc32 对照
      makeZip: makeZip,
      getDedupStats: function () {
        return { skippedSaved: S.skippedSaved, skippedDownloaded: S.skippedDownloaded, dlSize: S.dlSet.size };
      },
    };
  }

  init();

  
})();
