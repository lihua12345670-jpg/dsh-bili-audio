# Changelog

本项目遵循「版本号主.次.修订」；条目按版本倒序。

## 0.2.0 — 2026-10-23

在 v0.1 的解析和播放之上补齐「刷新还在」和番剧链接。仍然不登录、不读 Cookie、不抓字幕、不下载、不做离线缓存。

### 宿主半侧（`lib/index.js`）

- `resolve` 接受番剧 `ep` / `ss`（含 `b23.tv/ep…`、`b23.tv/ss…`、`?ep_id=`）、媒体页 `md`、旧站 `/anime/{mediaId}`。
  - `ss` 和媒体页播放第一集正片；指定了 `ep` 就播那一集（正片里没有时会到 section 里找）；
  - 季信息走 `pgc/view/web/season`，媒体页先经 `pgc/view/web/media` 换成 `season_id`，音频走 `pgc/player/web/playurl`；
  - 时长按接口的毫秒折成秒。
- 不支持的页面返回 `unsupported_link`：直播、课堂（cheese）、专栏/动态、个人空间、音频区、没有编号的番剧索引。
- 番剧失败有单独的码：`bangumi_not_found`、`bangumi_restricted`、`bangumi_failed`、`episode_not_found`、`no_episode`。没有音频流仍是 `no_audio_stream`。
- 安全边界不变：页面域名白名单、CDN 白名单、重定向后再校验主机、不转发 Cookie、id 只允许数字。

### 客户端半侧（`lib/client.js`）

- `localStorage` 键 `dsh-bili-audio:library` 保存队列元数据、当前条目、播放进度、最近播放（最多 30 条，队列最多 100 条）。
- 音频 CDN 地址不入库。刷新后只重新解析当前条目，不自动播放；其它条目点开再解析。
- `dsh-bili-audio:prefs` 仍只存展开状态、音量、倍速。
- 快捷键：空格播放/暂停，← → 进退 10 秒，Shift+← / Shift+→ 上一条/下一条。输入框和按钮上的空格不劫持。
- 空队列说明支持的链接和快捷键；失败原因写在队列行上（两行，悬停看全文）。
- 输入框 Enter 解析并播放，Shift+Enter 只入队。粘贴 `ep` / `ss` 编号会入队。

### 工程

- 版本号 0.2.0。
- `node --test` 覆盖番剧解析、不支持的链接、队列序列化（含「不保存音频地址」）和快捷键。
- `scripts/smoke.mjs` 增加公开番剧 `ep` / `ss`，以及课堂链接必须返回 `unsupported_link`。

## 0.1.0 — 2026-10-22

首个可安装版本，从自制 Python 桌宠（`bili_audio.py` / `bili_player.py`）移植。

### 宿主半侧（`lib/index.js`）

- `GET /bili-audio/api/resolve`：BV 号 / av 号 / 视频页链接 / `b23.tv` 短链 → 视频标题、bvid、cid、时长、DASH 音频地址与备用地址。
  - DASH 音频按 `bandwidth` 选最高码率，兼容 `dash.audio` / `dash.flac.audio` / `dash.dolby.audio`；
  - 没有 DASH 时回退 `durl`；
  - 支持 `?p=` 分 P，越界自动夹到最后一 P。
- `GET /bili-audio/api/stream`：反向代理音频字节。
  - 带 `Referer: https://www.bilibili.com/` 与桌面 UA，解决 CDN 403；
  - 透传浏览器 `Range`，回传 `Content-Range` / `Accept-Ranges` / `Content-Length`，支持 206；
  - 把 CDN 的 `application/octet-stream` 归一成 `audio/mp4`，否则 `<audio>` 不认；
  - 客户端断开时取消上游请求。
- `GET /bili-audio/api/health`：`{ok:true, version}`。
- 安全：resolve 只认 B 站页面域名；stream 只代理 B 站音频 CDN；重定向后二次校验最终主机；拒绝内嵌凭据 / 非 http(s) / IP 字面量。
- 所有外呼 15 秒超时；错误统一为 `{error:{code,message}}`，不抛裸栈。

### 客户端半侧（`lib/client.js`）

- 注册在 `shell.overlay`，右下角悬浮播放条，可最小化/展开；
- 粘贴框支持多链接批量入队；「解析并播放」/「只入队」两种语义；
- 原生 `<audio>` + 自定义进度条 / 音量 / 倍速 / 上一条 / 下一条 / 队列（点击切歌、移除、排序、清空）；
- 播放失败回退链：备用 CDN 地址 → 重新解析一次 → 探测错误码并显示原因；
- 样式注入 `<style data-plugin-css>`，颜色全部走 DSH 设计令牌 + `light-dark()` 兜底，跟随深浅色；
- 中英文案跟随 `<html lang>`，语言切换实时生效。

### 工程

- `package.json`（`dsh.bundle.patch` / `dsh.client.inject` / `engines.dsh`）、`cordis.patch.yml`、MIT LICENSE、中英文 README；
- `tests/`：URL/BV 解析、页面与 CDN 白名单、resolve 参数校验与错误映射、206 透传、客户端 bundle 结构、清单一致性（`node --test`）；
- `scripts/smoke.mjs`：真实网络冒烟（resolve + 代理前 200KB）。
