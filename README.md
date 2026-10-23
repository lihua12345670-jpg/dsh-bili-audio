# dsh-bili-audio

把「B 站视频」当播客听的 DSH 插件：在 Web 界面右下角挂一条悬浮播放条，粘贴 BV / av、视频链接或番剧 `ep` / `ss` 就能听声音。支持队列、进度、音量、倍速、上一条/下一条；队列和最近播放记在本机，刷新还在。中英文案跟随界面语言。不需要登录，也不读取 Cookie。

> 从一套自制的 Python 桌宠（`bili_audio.py` / `bili_player.py`）移植而来。v0.2 做解析、播放、队列、本地队列/历史，以及番剧 `ep` / `ss`。没有字幕、登录、下载或离线缓存。

播放条本身（队列来自本地记录：一条已保存，一条地区限制失败。不是 DSH 窗口的录屏）：

![dsh-bili-audio 播放条](docs/player.png)

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

克隆仓库后从本地目录安装（把路径换成你的副本；`--profile` 按实际 profile 名，桌面版通常是 `desktop`）：

```bash
git clone https://github.com/lihua12345670-jpg/dsh-bili-audio.git
dsh plugin --profile desktop add link:./dsh-bili-audio
```

若包已发布到 npm：

```bash
dsh plugin --profile desktop add dsh-bili-audio
```

安装后在 DSH Web 界面右下角会出现一个「♪」圆形按钮，点开是播放条；也可以在「设置 → 插件」里确认 `dsh-bili-audio` 已加载。

## 使用

1. 点右下角「♪」展开播放条；
2. 粘贴 B 站链接或编号：
   - 视频页 `https://www.bilibili.com/video/BV...`、`b23.tv` 短链、BV 号、av 号；
   - 番剧 `https://www.bilibili.com/bangumi/play/ep...`、`.../ss...`、`b23.tv/ep...`、`b23.tv/ss...`，或裸编号 `ep123` / `ss123`；
   - 媒体页 `.../bangumi/media/md...` 会先换成对应季，再播放第一集正片；
3. 点「解析并播放」（输入框里按 Enter 等价；Shift+Enter 是「只入队」）；
4. 多条用空格、换行或逗号分开：会依次加入队列。「只入队」不抢占当前播放；
5. 队列里点任意一条切歌，× 移除，「按标题排序」「清空」在队列头部。失败原因直接写在该行上（最多两行，悬停可看全文）。

`ss` 和媒体页没有指定集时播放**第一集正片**，不读取观看进度（那需要登录）。`?ep_id=` 或路径里的 `ep` 会点名那一集。

播放失败时会自动尝试备用 CDN 地址，再重新解析一次（B 站音频地址带 `deadline`，过期只能重新要）；仍然失败会在队列行内显示具体原因（例如 CDN 403、该视频没有音频流、番剧地区限制）。

播放条展开时（焦点不在输入框或按钮上）：

| 键 | 作用 |
| --- | --- |
| 空格 / 媒体播放键 | 播放 / 暂停 |
| ← / → | 后退 / 前进 10 秒 |
| Shift+← / Shift+→ | 上一条 / 下一条 |

## 本地记住什么

只写在这个浏览器的 `localStorage` 里，不上传。

| 键 | 内容 |
| --- | --- |
| `dsh-bili-audio:prefs` | 展开还是收起、音量、倍速 |
| `dsh-bili-audio:library` | 队列（链接、标题、bvid、cid、时长、错误文案）、当前条目、播放进度、最近播放（最多 30 条） |

**不入库、刷新后也不会自动出现：**

- 音频 CDN 地址和备用地址（带 `deadline`，过期必 403）。刷新后只重新解析**当前**这一条；队列里其它条目等你点开再解析；
- 是否正在播放。刷新后停在原来的进度上，需要再点一次播放；
- 字幕、Cookie、登录态、下载文件、离线音频。

清空队列不会清掉「最近」。点最近里的一条会重新入队并播放。队列最多保留 100 条。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/bili-audio/api/health` | `{ok:true, version}` |
| GET | `/bili-audio/api/resolve?url=<BV/av/ep/ss/链接>` | `{ok:true, title, bvid, cid, duration, page, pages, audioUrl, backups[], mimeType, codecs}`。番剧还会带 `epId`、`seasonId` |
| GET | `/bili-audio/api/stream?u=<urlencoded audioUrl>` | 反向代理音频字节，支持 `Range` 与 206 |

错误统一是：

```json
{ "error": { "code": "no_audio_stream", "message": "这个视频没有可用的音频流（可能是充电专属、付费或地区限制内容）" } }
```

常见 `code`：`missing_url`、`invalid_url`、`host_not_allowed`、`no_video_id`、`unsupported_link`、`video_not_found`、`bangumi_not_found`、`bangumi_restricted`、`episode_not_found`、`no_episode`、`no_audio_stream`、`playurl_failed`、`cdn_forbidden`、`cdn_gone`、`upstream_timeout`、`upstream_unreachable`、`short_link_foreign`。

`unsupported_link` 用于已经认得、但故意不播的页面：直播、课堂（cheese）、专栏/动态、个人空间、音频区，以及没有编号的番剧索引页。

## 安全边界

这个插件挂了一个「替浏览器发请求」的路由，所以白名单是硬编码的，不是配置项：

- `resolve` 只接受 `bilibili.com` / `b23.tv` / `bilibili.tv` 的页面链接（含子域）；
- `stream` 只代理 `*.bilivideo.com`、`*.akamaized.net`、`*.mcdn.bilivideo.cn`、`*.bilibili.com`；
- 跟随 CDN 重定向后会**再校验一次最终主机**，避免 CDN 302 到别处把插件当跳板；
- 拒绝带用户名/密码的 URL、非 `http(s)` 协议、IP 字面量（`127.0.0.1`、`[::1]`）；
- 只透传浏览器的 `Range`，不转发 `Cookie` / `Authorization` 等其它请求头；
- 单次外呼 15 秒超时；客户端断开时立刻取消上游连接。

它不是一个通用 CORS/代理工具：任何不在上述白名单里的 URL 都会得到 400。

## 已知限制（v0.2）

- **没有字幕、登录、Cookie、下载、离线缓存**。原 Python 版的 CC/AI 字幕需要登录 Cookie，这个插件不读 Cookie，也不把浏览器的 `Cookie` / `Authorization` 转给 B 站；
- **需要联网**：解析与播放都依赖 B 站接口与 CDN。队列元数据在本地，音频字节不缓存；
- 充电专属、付费、大会员、地区限制、需要登录的内容可能没有音频流，会返回 `no_audio_stream` 或 `bangumi_restricted`；
- 番剧 `ss` / 媒体页只解析**一集**（第一集正片，或 `ep` / `?ep_id=` 点名的那一集），不会把整季自动塞进队列；
- 直播、课堂、专栏、空间、音频区链接会得到 `unsupported_link`，不会当成视频去猜；
- 播放依赖浏览器的自动播放策略：解析后的自动播放若被拦截，点一下播放按钮即可。刷新页面也不会自动开播。

## 开发

```bash
node --test tests/*.test.mjs   # 单元测试（不联网）：解析、番剧、白名单、队列持久化、快捷键
node scripts/smoke.mjs         # 真实网络冒烟：公开视频 + 公开番剧 ep/ss，并代理音频前 200KB
```

冒烟可用环境变量换目标：`BILI_SMOKE_BVID`（默认 `BV1GJ411x7h7`）、`BILI_SMOKE_EP`（默认西游记 `ep327107`）、`BILI_SMOKE_SS`（默认 `ss33622`）。地区限制时番剧会得到 `bangumi_restricted`，脚本会记为失败。部分网络上 `x/web-interface/view` 会直接 412，这时普通视频那一步失败，番剧解析和它的音频代理仍会继续跑。

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
