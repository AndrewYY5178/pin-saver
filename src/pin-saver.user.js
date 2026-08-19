// ==UserScript==
// @name         Pinterest 批量保存素材
// @namespace    pin-saver
// @version      0.2.4
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
    dlSet: new Set(),       // 本地已下载 key 集合（GM 存储持久化，跨会话；init 时异步加载）
    skippedKeys: new Map(), // key -> 'saved'|'dl'（已判跳过的不重复计数）
    skippedSaved: 0,
    skippedDownloaded: 0,
    log: '',
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
  async function fetchBlob(url) {
    try {
      var buf = await gmFetch(url);
      return new Blob([buf]);
    } catch (e) {
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, 30000);
      try {
        var res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error('fetch status ' + res.status);
        return await res.blob();
      } catch (e2) {
        try { console.warn('[pin-saver] 下载失败 ' + String(url).slice(0, 70) + '：' + (e2 && e2.message || e2)); } catch (e3) {}
        throw e2;
      } finally { clearTimeout(t); }
    }
  }

  // HLS：解析 m3u8 → 逐片下载 → 按序二进制拼接（无需 ffmpeg）
  async function fetchM3u8AndSegments(m3u8Url) {
    var text = await (await fetchBlob(m3u8Url)).text();
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
      try { parts.push(await fetchBlob(urls[k])); }
      catch (e) { S.skippedSegments++; }
    }
    if (!parts.length) throw new Error('HLS 分片全部下载失败');
    return {
      blob: new Blob(parts, { type: initMap ? 'video/mp4' : 'video/mp2t' }),
      ext: initMap ? 'mp4' : 'ts',
    };
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
        return { blob: new Blob([buf], { type: 'video/mp4' }), ext: 'mp4' };
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

  function fileStem(item, idx) {
    var nnn = String(idx + 1).padStart(3, '0');
    var tag = item.id || (hashOf(item.origUrl) || '').slice(0, 8) || 'unknown';
    return nnn + '-' + tag + '-' + (sanitize(item.title) || 'untitled');
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
    var stem = fileStem(info, idx);

    if (info.isVideo) {
      // 1) 登录态 API 的 video_list；2) 海报 hash 构造直链；3) 封面兜底
      var got = null;
      if (info.videoList) {
        var best = getBestVideo(info.videoList);
        if (best) {
          try {
            got = best.isHls
              ? await fetchM3u8AndSegments(best.url)
              : { blob: await fetchBlob(best.url), ext: 'mp4' };
          } catch (e) { /* 落下一级 */ }
        }
      }
      if (!got && info.origUrl) got = await tryConstructMp4(info.origUrl);
      if (got) {
        folders.videos.file(stem + '.' + got.ext, got.blob);
        S.dlSet.add(item.key);
        return;
      }
      try {
        var cover = await fetchBlob(item.origUrl);
        folders.videos.file(stem + '_cover.' + extOf(item.origUrl), cover);
        S.dlSet.add(item.key);
        notes.push(stem + '：视频直链不可得（未登录平台限制），仅保存封面');
      } catch (e2) {
        notes.push(stem + '：视频与封面均下载失败');
      }
      return;
    }

    try {
      var blob = await fetchBlob(info.origUrl);
      folders.images.file(stem + '.' + extOf(info.origUrl), blob);
      S.dlSet.add(item.key);
    } catch (e) {
      if (item.thumbUrl && item.thumbUrl !== info.origUrl) {
        try {
          var tb = await fetchBlob(item.thumbUrl);
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
    var zip = new JSZip();
    var folders = {
      images: zip.folder('images'),
      videos: zip.folder('videos'),
      errors: zip.folder('error_thumbnails'),
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
    zip.file('说明.txt',
      'Pinterest 批量保存说明\n'
      + '生成时间: ' + new Date().toLocaleString() + '\n'
      + '共处理 ' + total + ' 个 pin\n'
      + '去重设置: 跳过已收藏=' + (S.cfg.skipSaved ? '开' : '关') + '，跳过已下载=' + (S.cfg.skipDownloaded ? '开' : '关') + '\n'
      + '提示: 「已收藏」检测依赖页面标记，未登录或页面改版时自动失效（宁可多收）。\n\n'
      + (notes.length
        ? '降级 / 失败记录:\n' + notes.map(function (n) { return '- ' + n; }).join('\n')
        : '全部成功，无降级项。'));
    var name = 'pinterest-' + detectPageType() + '-' + stamp() + '.zip';
    try {
      S.progress = '下载完成，生成 zip 中…';
      renderPanel();
      // streamFiles 降低内存峰值；STORE 因为图片/视频已是压缩格式，再压无收益只费 CPU
      var blob = await zip.generateAsync({ type: 'blob', streamFiles: true, compression: 'STORE' });
      S.lastZip = { blob: blob, name: name };   // 「下载 zip」按钮兜底：点击时新建用户手势，必定触发
      flushDlSet();
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
          : { blob: await fetchBlob(best.url), ext: 'mp4' };
        downloadBlob(got.blob, sanitize(detail.title || ('pin-' + id)) + '.' + got.ext);
        S.dlSet.add(item ? item.key : ('pin-' + id));
        log('视频已保存');
      } else if (detail && detail.origUrl) {
        var b1 = await fetchBlob(detail.origUrl);
        downloadBlob(b1, sanitize(detail.title || ('pin-' + id)) + '.' + extOf(detail.origUrl));
        S.dlSet.add(item ? item.key : ('pin-' + id));
        log('图片已保存');
      } else if (item) {
        var b2 = await fetchBlob(item.origUrl);
        downloadBlob(b2, sanitize(item.title || ('pin-' + (id || ''))) + '.' + extOf(item.origUrl));
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
  function ensureFab() {
    if (document.getElementById('psaver-fab')) return;
    var fab = document.createElement('div');
    fab.id = 'psaver-fab';
    fab.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483646;background:#111;color:#fff;'
      + 'font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:10px 14px;'
      + 'border-radius:24px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.25);'
      + 'user-select:none;display:flex;align-items:center;gap:8px;';
    fab.innerHTML = '<span>保存</span>'
      + '<span id="psaver-count" style="display:none;background:#e60023;border-radius:10px;'
      + 'padding:1px 7px;font-size:11px;">0</span>';
    fab.addEventListener('click', function () {
      S.panelOpen = !S.panelOpen;
      renderPanel();
    });
    document.body.appendChild(fab);
  }

  function ensurePanel() {
    if (document.getElementById('psaver-panel')) return;
    var el = document.createElement('div');
    el.id = 'psaver-panel';
    el.style.cssText =
      'position:fixed;right:16px;bottom:64px;z-index:2147483646;width:290px;background:#fff;'
      + 'color:#111;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
      + 'border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.18);padding:14px;display:none;';
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      + '<b>Pinterest 批量保存</b> <span id="psaver-ver" style="font-size:11px;color:#999;"></span>'
      + '<span id="psaver-close" style="cursor:pointer;color:#999;font-size:15px;line-height:1;">x</span>'
      + '</div>'
      + '<div id="psaver-status" style="margin-bottom:6px;">已收集 0 个</div>'
      + '<div id="psaver-progress" style="margin-bottom:8px;color:#666;min-height:18px;"></div>'
      + '<div id="psaver-opts" style="margin-bottom:10px;font-size:12px;color:#444;">'
      + '<label style="display:flex;align-items:center;gap:6px;margin-bottom:4px;cursor:pointer;">'
      + '<input type="checkbox" id="psaver-opt-saved" style="margin:0;"> 跳过已收藏'
      + '<span id="psaver-opt-saved-note" style="display:none;color:#999;">（收藏夹页自动关闭）</span></label>'
      + '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;">'
      + '<input type="checkbox" id="psaver-opt-dl" style="margin:0;"> 跳过已下载过的</label>'
      + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
      + '<button id="psaver-start" style="flex:1;padding:7px 0;background:#111;color:#fff;border:0;'
      + 'border-radius:8px;cursor:pointer;font:inherit;">开始收集</button>'
      + '<button id="psaver-stop" style="flex:1;padding:7px 0;background:#fff;color:#111;'
      + 'border:1px solid #ccc;border-radius:8px;cursor:pointer;font:inherit;display:none;">停止</button>'
      + '<button id="psaver-zip" style="flex:1;padding:7px 0;background:#e60023;color:#fff;border:0;'
      + 'border-radius:8px;cursor:pointer;font:inherit;">打包下载 ZIP</button>'
      + '<button id="psaver-single" style="display:none;width:100%;padding:7px 0;background:#111;'
      + 'color:#fff;border:0;border-radius:8px;cursor:pointer;font:inherit;">保存此 pin</button>'
      + '<button id="psaver-redl" style="display:none;width:100%;padding:9px 0;background:#e60023;color:#fff;'
      + 'border:0;border-radius:8px;cursor:pointer;font:inherit;font-weight:bold;">下载 zip</button>'
      + '</div>'
      + '<div id="psaver-log" style="margin-top:8px;color:#888;min-height:18px;"></div>';
    document.body.appendChild(el);

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
    try {
      el.querySelector('#psaver-ver').textContent =
        'v' + scriptVersion() + (typeof GM_info !== 'undefined' && GM_info.version ? ' · TM ' + GM_info.version : '');
    } catch (e) {}
  }

  // v0.2.3：面板日志同时写 Console（[pin-saver] 前缀，F12 可查；Pinterest 页面的其他警告与此脚本无关）
  function log(msg) {
    S.log = msg;
    try { console.log('[pin-saver] ' + msg); } catch (e) {}
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

    document.getElementById('psaver-log').textContent = S.log || '';
    } catch (e) { /* 面板渲染异常不阻断下载流程 */ }
  }

  /* ===== [INIT] 入口 ===== */
  var lastPath = location.pathname;

  function init() {
    loadDlSet().then(function (s) { S.dlSet = s; });   // GM 存储异步读回（v0.2.2 修复跨会话去重）
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
      labelMeansSaved: labelMeansSaved,
      isSavedCard: isSavedCard,
      loadDlSet: loadDlSet,
      flushDlSet: flushDlSet,
      collectPins: collectPins,
      downloadBlob: downloadBlob,
      getDedupStats: function () {
        return { skippedSaved: S.skippedSaved, skippedDownloaded: S.skippedDownloaded, dlSize: S.dlSet.size };
      },
    };
  }

  init();

  /*__JSZIP_SOURCE__*/
})();
