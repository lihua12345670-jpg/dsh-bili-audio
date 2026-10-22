# dsh-bili-audio

把「B 站视频」当播客听的 DSH 插件：在 Web 界面右下角挂一条悬浮播放条，粘贴 BV 号或链接就能听声音。支持队列、进度、音量、倍速、上一条/下一条，中英文案跟随界面语言。

> 这是从一套自制的 Python 桌宠（`bili_audio.py` / `bili_player.py`）移植过来的 DSH 插件版，v0.1 只做「解析 + 播放 + 队列」，没有字幕/登录/下载。

## 为什么需要宿主代理

B 站音频 CDN（`*.bilivideo.com`、`*.mcdn.bilivideo.cn` 等）会校验 `Referer`。浏览器里直接 `<audio src="https://...bilivideo.com/...m4s">` 会拿到 **403**，因为请求的 Referer 是本机页面。

所以本插件的音频字节全部走宿主侧的 `/bili-audio/api/stream`：

```
浏览器 <audio>
   │  GET /bili-audio/api/stream?u=<encodeURIComponent(audioUrl)>   (带 Range)
   ▼
DSH 宿主（Node）
   │  GET <audioUrl>
   │  User-Agent: Chrome 桌面 UA
   │  Referer: https://www.bilibili.com/
   ▼
B 站音频 CDN  →  200 / 206 + 音频字节
```

代理会把浏览器的 `Range` 原样透传，并把 `Content-Range` / `Accept-Ranges` / `Content-Length` 回给浏览器，因此进度条可以拖动（206 分段请求正常工作）。

## 安装

本地目录（开发/试用）：

```bash
dsh plugin --profile desktop add link:E:\工作区\dsh-bili-audio
```

从 npm 安装（发布后）：

```bash
dsh plugin --profile desktop add dsh-bili-audio
```

安装后在 DSH Web 界面右下角会出现一个「♪」圆形按钮，点开是播放条；也可以在「设置 → 插件」里确认 `dsh-bili-audio` 已加载。

## 使用

1. 点右下角「♪」展开播放条；
2. 粘贴 B 站链接（`https://www.bilibili.com/video/BV...`、`b23.tv` 短链）或直接贴 BV 号 / av 号；
3. 点「解析并播放」；
4. 多条链接用空格/换行分隔后一起粘贴：会依次加入队列（「只入队」不会抢占当前播放）；
5. 队列里点任意一条即可切歌，× 移除，「按标题排序」「清空」在队列头部。

播放失败时会自动尝试备用 CDN 地址，再重新解析一次（B 站音频地址带 `deadline`，过期只能重新要）；仍然失败会在队列行内显示具体原因（例如 CDN 403、该视频没有音频流）。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/bili-audio/api/health` | `{ok:true, version}` |
| GET | `/bili-audio/api/resolve?url=<BV/av/链接>` | `{ok:true, title, bvid, cid, duration, page, pages, audioUrl, backups[], mimeType, codecs}` |
| GET | `/bili-audio/api/stream?u=<urlencoded audioUrl>` | 反向代理音频字节，支持 `Range` 与 206 |

错误统一是：

```json
{ "error": { "code": "no_audio_stream", "message": "这个视频没有可用的音频流（可能是充电专属、付费或地区限制内容）" } }
```

常见 `code`：`missing_url`、`invalid_url`、`host_not_allowed`、`no_video_id`、`video_not_found`、`no_audio_stream`、`playurl_failed`、`cdn_forbidden`、`cdn_gone`、`upstream_timeout`、`upstream_unreachable`、`short_link_foreign`。

## 安全边界

这个插件挂了一个「替浏览器发请求」的路由，所以白名单是硬编码的，不是配置项：

- `resolve` 只接受 `bilibili.com` / `b23.tv` / `bilibili.tv` 的页面链接（含子域）；
- `stream` 只代理 `*.bilivideo.com`、`*.akamaized.net`、`*.mcdn.bilivideo.cn`、`*.bilibili.com`；
- 跟随 CDN 重定向后会**再校验一次最终主机**，避免 CDN 302 到别处把插件当跳板；
- 拒绝带用户名/密码的 URL、非 `http(s)` 协议、IP 字面量（`127.0.0.1`、`[::1]`）；
- 只透传浏览器的 `Range`，不转发 `Cookie` / `Authorization` 等其它请求头；
- 单次外呼 15 秒超时；客户端断开时立刻取消上游连接。

它不是一个通用 CORS/代理工具：任何不在上述白名单里的 URL 都会得到 400。

## 已知限制（v0.1）

- **没有字幕**：原 Python 版的 CC/AI 字幕需要登录 Cookie，v0.1 不做登录，也不抓字幕；
- **没有收藏/历史**：队列只在内存里，刷新页面就清空；只持久化「展开状态 / 音量 / 倍速」；
- **需要联网**：解析与播放都依赖 B 站接口与 CDN，没有离线缓存；
- 充电专属、付费、地区限制、需要登录的视频可能没有音频流，会显示「该视频没有可用的音频流」；
- 只支持视频页链接 / BV / av；番剧 `ep`/`ss` 链接暂不支持（会被当作「链接里没有 BV 号」）；
- 播放依赖浏览器的自动播放策略：解析后的自动播放若被拦截，点一下播放按钮即可。

## 开发

```bash
node --test tests/*.test.mjs   # 单元测试（不联网）
node scripts/smoke.mjs         # 真实网络冒烟：resolve 一个公开视频并代理前 200KB
```

目录：

```
lib/index.js        宿主半侧：resolve / stream / health 三个路由 + 白名单
lib/client.js       客户端半侧：shell.overlay 悬浮播放条（手写 bundle，无构建）
cordis.patch.yml    挂载声明
tests/*.test.mjs    node --test 用例
scripts/smoke.mjs   联网冒烟脚本
```

## 许可

MIT。代码是从用户自制的桌宠项目移植的，音频版权归 B 站与相应 UP 主所有；本插件只做本地播放，不下载、不转存、不二次分发。
