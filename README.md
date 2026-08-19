# Pinterest 批量保存素材 (pin-saver)

一个油猴脚本：在 Pinterest 页面上点几下，批量收集图片 / GIF / 视频的**原始高清文件**（不压缩），打包成单个 Zip 下载。登录或未登录都能用，Edge 与 Chrome 通用。

## 为什么是油猴脚本（而不是扩展 / 书签 + 本地服务）

- **跨浏览器**：同一个 `.user.js` 文件，Edge / Chrome 各装一次 Tampermonkey 后通用，改一次两边生效。
- **单文件、零依赖、零服务**：没有构建工具链、没有本地服务要启动、没有应用商店审核。
- 之前小红书项目（xhs-capture）用「书签 + 本地服务」是因为小红书的 CSP 会拦截扩展 / 油猴注入的脚本；**Pinterest 没有这个限制**（GitHub 上同类油猴工具均正常工作）。

## 组成

| 文件 | 作用 |
|---|---|
| `dist/pin-saver.user.js` | **成品脚本**——拖进 Tampermonkey 安装的安装文件 |
| `src/pin-saver.user.js` | 可读源码（改这里后用 `node build.mjs` 重新生成） |
| `build.mjs` | 把源码与内嵌的 JSZip 合并为成品（`node build.mjs`） |
| `smoke.mjs` | 核心纯函数自测（`node smoke.mjs`） |
| `vendor/jszip.min.js` | 内嵌的 JSZip（构建时打包进成品，运行时离线可用） |

## 安装（一次性；Edge 和 Chrome 各做一次）

1. 装脚本管理器：Edge 扩展商店 / Chrome 网上应用店搜索 **Tampermonkey**（Violentmonkey 也可以）。**建议升级到最新版**：旧版（< 5.4.6226）存在「请求超时不生效」「超时后自动拉黑网址」等 bug，会导致批量下载卡死。
2. 打开 Tampermonkey 管理面板 → 「实用工具」→「导入」→ 选择本项目的 `dist/pin-saver.user.js`。
3. 打开 `pinterest.com` 任意页面，右下角出现「保存」按钮即成功；按 F12 打开 Console 可见 `pin-saver loaded`。

### 从 GitHub 安装 / 更新（推荐）

- **安装**：浏览器直接打开 `https://raw.githubusercontent.com/AndrewYY5178/pin-saver/main/dist/pin-saver.user.js`，Tampermonkey 会自动弹出安装确认页，点「安装」即可。
- **更新**：打开 Tampermonkey 管理面板 →「已安装脚本」→ 点进本脚本 → 点「更新」按钮（对从上面 raw 地址安装的脚本有效，Tampermonkey 会检查远端新版本）。
- 本地文件安装的旧版想更新：在管理面板「实用工具」重新导入新 `dist/pin-saver.user.js` 覆盖即可。

## 日常使用

| 场景 | 页面 | 操作 |
|---|---|---|
| 批量 · 搜索页 / 主页 feed（未登录也可） | `pinterest.com` 或搜索页 | 点「保存」→ 点「开始收集」（自动滚动收集）→ 滚完点「打包下载 ZIP」 |
| 批量 · 自己的画板（登录） | 打开某个画板页 | 同上两步 |
| 单张 · pin 详情页 | 打开 `/pin/123/` 详情页 | 点「保存」→ 点「保存此 pin」 |

- 收集自动停止条件：页面高度连续 12 轮不再增长，或达到收集上限（默认 300，改 `src/pin-saver.user.js` 里的 `CFG.maxCollect` 后重新 `node build.mjs`）。
- 打包进度在面板显示；zip 内 `images/` 放图片、`videos/` 放视频、`说明.txt` 记录降级项（如「视频仅封面」）。
- 收集期间可以随时点「停止」，已收集的部分仍可打包。
- 面板有两个去重开关（默认勾选）：「**跳过已收藏**」——跳过你在 Pinterest 上已收藏过的 pin（依赖登录态页面标记，收藏夹页会自动关闭该跳过）；「**跳过已下载**」——跳过本地记录里已下载过的素材（记录存在 Tampermonkey 存储中，跨会话有效）。
- 打包完成后若浏览器没有自动弹出下载，点面板的「**下载 zip**」按钮即可（点击时的新用户手势必定触发下载，文件在浏览器默认下载目录，`Ctrl+J` / `Cmd+Shift+J` 查看下载列表）。
- 若「打包下载 ZIP」按钮点击后一直灰色、很久不恢复：说明某个网络请求挂起，脚本会在 10 分钟内自动恢复（看面板日志）；也可以刷新页面重试。建议升级 Tampermonkey 到最新版（旧版有请求超时不生效、超时后自动拉黑网址的 bug）。

## 工作原理（维护用）

- **原图还原**：页面上的 img 是压缩图（`/236x/` `/474x/` `/736x/` 路径），把尺寸段替换为 `/originals/` 即得原始高清图（同一 hash）。看 `toOriginalUrl()` / `pickBestUrl()`。
- **双路径提取**：登录态优先调 Pinterest 内部接口（`PinResource/get`）拿标题与视频直链；失败（未登录必 403）静默降级为 DOM 数据。DOM 是主路径，API 仅增强。看 `pinDetail()`。
- **收集**：自动滚动 + MutationObserver + 轮询，按 pin id / 原图 hash 去重。看 `collectPins()` / `autoScroll()`。
- **下载**：`GM.xmlHttpRequest`（无 CORS 限制，带 Referer）优先，失败回退页面 fetch。**每个请求都有脚本层硬超时**（GM 用守卫定时器 + abort、fetch 用 AbortController），保证请求即使挂起也必定结束——Tampermonkey 自带的 `timeout` 在 Chrome MV3 下不生效，不能依赖。看 `gmFetch()` / `fetchBlob()`。
- **视频**：`video_list` 按分辨率取最高，MP4 直链优先；只有 HLS 时解析 m3u8 分片并顺序拼接（无需 ffmpeg）。看 `getBestVideo()` / `fetchM3u8AndSegments()`。
- **GIF**：Pinterest 的 GIF pin 原图直接以 `.gif` 结尾，按图片路径下载即保留动图。
- **去重**：收集时按卡片保存按钮的 `aria-label`（含 "Saved" /「已保存」）跳过已收藏 pin（仅登录态有该标记，未登录自动全收）；按本地 `GM_setValue` 记录跳过已下载过的（key = pin id 或原图 hash）。看 `isSavedCard()` / `loadDlSet()` / `flushDlSet()`。
- **下载**：打包完成后用页面 `a[download]` 触发下载，并保留 zip 到面板「下载 zip」按钮——点击按钮时是新用户手势，必定触发（`GM_download` 对 blob URL 会存成 txt，已弃用）。打包流程有 try/finally + 总时长看门狗（`CFG.zipWatchdogMs`，默认 10 分钟）：任何异常或网络挂起都会恢复面板按钮，不会卡在灰色状态。看 `saveZip()` / `downloadBlob()`。
- **zip 生成**：`generateAsync({ type: 'blob', streamFiles: true, compression: 'STORE' })`——图片/视频已是压缩格式，STORE 省 CPU、streamFiles 降低内存峰值。

## 已知限制

- **Pinterest 前端改版**（最高风险）：DOM 结构可能变化。脚本用多选择器候选 + 按属性（srcset / originals）而非 class 名驱动，坏一处只跳过单张；某类素材收不到时看 Console 反馈。
- **「跳过已收藏」依赖页面标记**：登录态卡片才有保存按钮，前端改版或未登录时该检测自动失效（宁可多收、不漏收）。
- **内部 API 不稳定**：`PinResource/get` 是非公开接口，仅登录态增强；失败自动熔断，不影响主流程。
- **未登录限流**：Pinterest 对未登录高频滚动有限流与登录墙，建议单次收集控制在几十张级；未登录时视频通常只能拿到封面（平台不提供直链）。
- **HLS 缺片**：个别分片可能被防盗链拒绝，跳过该片并在 `说明.txt` 记录（视频可播放但可能卡顿）。
- **图集 pin（story pin）**：只保存第一张，不展开多图。
- **内存**：Zip 全内存打包，300 张原图约 300–600MB；超大画板可调低 `CFG.maxCollect` 分两次打包。

## 免责声明与使用须知

- 本工具按「现状」提供，仅供个人学习与研究。**使用本工具的一切风险由使用者自行承担**，作者不对因使用本工具产生的任何后果负责，包括但不限于违反平台服务条款、账号受限、数据丢失等。
- 请遵守 Pinterest 的服务条款，只保存你自己有权访问、已公开浏览的内容，合理控制频率（滚动间隔 800ms 起），勿用于大规模批量爬取。
- **通过本工具获取的素材（图片、GIF、视频等）版权归原作者所有**；未经原作者许可，不得用于商业用途，也不得擅自公开传播。
- 代码本身以 MIT 协议开源（见 `LICENSE`）；上述内容版权与使用限制针对的是抓取到的第三方内容，与代码许可相互独立。
