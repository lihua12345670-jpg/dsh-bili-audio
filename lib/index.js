/**
 * dsh-bili-audio —— 宿主半侧
 *
 * 这个插件把「B 站视频」当成一份可以听的音频：解析出 DASH 音频流地址，再由本机
 * 反向代理转发给浏览器里的 <audio>。之所以必须有宿主代理，是因为 B 站音频 CDN
 * 校验 Referer —— 浏览器直接播 https://*.bilivideo.com/... 会拿到 403；代理带上
 * `Referer: https://www.bilibili.com/` 与桌面 UA 才能取到字节。
 *
 * 对界面只暴露三个口子（全部挂在 webServer 的 exact 路由上）：
 *
 *   · GET /bili-audio/api/health            存活探测，给客户端确认宿主半侧在线
 *   · GET /bili-audio/api/resolve?url=...   链接 / BV 号 → 音频流信息
 *   · GET /bili-audio/api/stream?u=...      反向代理音频字节，透传 Range / 206
 *
 * 安全边界（这是本插件最容易被误用成「开放代理」的地方，所以写死白名单）：
 *
 *   · resolve 只接受 bilibili.com / b23.tv / bilibili.tv 三种页面域名；
 *   · stream 只代理 *.bilivideo.com / *.akamaized.net / *.mcdn.bilivideo.cn /
 *     *.bilibili.com 这些 B 站音频 CDN 主机，其余一律 400；
 *   · stream 跟随 CDN 重定向后还会再校验一次最终主机，避免 CDN 302 到别处把
 *     本插件变成任意 URL 的跳板；
 *   · 不接受带用户名/密码的 URL、不接受非 http(s) 协议、不接受 IP 字面量。
 *
 * 数据来源（与原桌宠的 Python 实现一致，见 bili_audio.py 的 resolve）：
 *   1. x/web-interface/view      拿 bvid / cid / 分 P 列表 / 时长；
 *   2. x/player/playurl fnval=16 拿 DASH 音频（audios 里按 bandwidth 选最高）；
 *      没有 DASH 时退回 durl（老视频/番剧的单文件流）。
 *
 * 运行期依赖只有 Node 内置的 fetch（DSH 桌面版主进程自带）。所有外呼都有 15 秒
 * 超时，异常一律收敛成 {error:{code,message}} 的 JSON，不把裸栈抛给界面。
 */

/* ------------------------------------------------------------------ *
 * 常量：域名白名单、UA、超时
 * ------------------------------------------------------------------ */

/** 插件在 DSH 配置树里的 id；与 cordis.patch.yml 的 id 一致。 */
export const name = 'bili-audio'

/** 依赖的宿主服务：HTTP 载体。没有 webServer 时插件不会被加载。 */
export const inject = ['webServer']

/** 本插件所有路由的公共前缀。 */
const API = '/bili-audio/api'

/** 与 package.json 的 version 对齐（tests 里会校验两者一致，防止漏改）。 */
export const VERSION = '0.1.0'

/**
 * 桌面 UA。B 站接口与 CDN 都会看 UA：默认的 Node/undici UA 会被当成爬虫，
 * 换成正正经经的 Chrome 桌面 UA 才稳定。
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36'

/** B 站接口与音频 CDN 都校验 Referer，缺了这个头就是 403。 */
const BILIBILI_REFERER = 'https://www.bilibili.com/'

/** 单次外呼（到响应头为止）的超时。15 秒与原始 Python 实现一致。 */
const REQUEST_TIMEOUT_MS = 15_000

/** 输入长度上限，防止有人拿超长串打日志 / 撑爆 URL 解析。 */
const MAX_LINK_LENGTH = 4096

/** 最多保留几个备用 CDN 地址：主地址 403 时客户端会按顺序换。 */
const MAX_BACKUPS = 5

/** 页面域名白名单：resolve 只认这三种（含子域）。 */
const PAGE_HOST_SUFFIXES = ['bilibili.com', 'b23.tv', 'bilibili.tv']

/** 短链域名：没有 BV 号，需要跟随 302 才能拿到真实视频页。 */
const SHORT_HOST_SUFFIXES = ['b23.tv']

/**
 * 音频 CDN 主机白名单（含子域）。
 *
 * 注意 mcdn 的音频地址带高位端口（例如 ...mcdn.bilivideo.cn:8082），所以这里
 * 只校验主机名、不校验端口 —— 端口不改变「请求最终落在哪个主机」，不会把代理
 * 变成任意端口扫描器。
 */
const CDN_HOST_SUFFIXES = [
  'bilivideo.com',
  'akamaized.net',
  'mcdn.bilivideo.cn',
  'bilibili.com',
]

/** BV 号：固定 12 位，「BV」+ 10 位 [0-9A-Za-z]。 */
const BV_RE = /BV[0-9A-Za-z]{10}/

/** av 号：用词边界，避免从 "nav123" 之类的单词里误抓。 */
const AV_RE = /\bav(\d{1,12})\b/i

/** 从一段自由文本里抓第一个 http(s) 链接。 */
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`]+/i

/* ------------------------------------------------------------------ *
 * 错误：统一成 {code, message, status}
 * ------------------------------------------------------------------ */

/**
 * 业务错误。code 是给客户端做分支用的稳定标识，message 是给人看的中文说明，
 * status 是应答的 HTTP 状态码。普通异常（fetch 抛错等）在外层统一收敛成 500。
 */
class BiliError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'BiliError'
    this.code = code
    this.status = status
  }
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 把任意异常收敛成 {status, body}。body 里只有 code / message，不带 stack ——
 * 界面用不到栈，而栈可能泄露本机路径。
 */
function toErrorPayload(error) {
  if (error instanceof BiliError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    }
  }
  return {
    status: 500,
    body: {
      error: { code: 'internal_error', message: '插件内部错误：' + messageOf(error) },
    },
  }
}

/* ------------------------------------------------------------------ *
 * 域名 / URL 校验
 * ------------------------------------------------------------------ */

/** 主机是否命中某个后缀白名单：允许「恰好等于」与「以 .后缀 结尾」。 */
function hostMatches(hostname, suffixes) {
  const host = String(hostname || '').toLowerCase()
  if (host === '') return false
  return suffixes.some((suffix) => host === suffix || host.endsWith('.' + suffix))
}

/**
 * 只接受 http(s)、无内嵌凭据、非 IP 字面量的 URL。
 * 拒绝 IP 字面量是为了堵住 `http://127.0.0.1/` 这类内网探测；B 站所有主机都是域名。
 */
function isPlainHttpUrl(value) {
  const host = String(value?.hostname || '')
  if (host === '') return false
  // IPv6 字面量在 URL 里是 "[::1]" 这种带方括号的形态
  if (host.startsWith('[') || host.endsWith(']')) return false
  // 纯 IPv4
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false
  if (value.username !== '' || value.password !== '') return false
  return value.protocol === 'https:' || value.protocol === 'http:'
}

/** 是否是 resolve 允许的 B 站页面 URL（不要求里面有 BV 号）。 */
function isAllowedPageUrl(value) {
  const url = value instanceof URL ? value : safeUrl(value)
  if (url === undefined || !isPlainHttpUrl(url)) return false
  return hostMatches(url.hostname, PAGE_HOST_SUFFIXES)
}

/** 是否是 stream 允许代理的 B 站音频 CDN URL。 */
function isAllowedCdnUrl(value) {
  const url = value instanceof URL ? value : safeUrl(value)
  if (url === undefined || !isPlainHttpUrl(url)) return false
  return hostMatches(url.hostname, CDN_HOST_SUFFIXES)
}

/** new URL 的不会抛版本：解析失败返回 undefined。 */
function safeUrl(value) {
  try {
    return new URL(String(value))
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * 输入解析：链接 / BV 号 / av 号
 * ------------------------------------------------------------------ */

/** 把分 P 参数收敛成正整数；"2"、2、垃圾值分别得到 2、2、1。 */
function parsePage(value) {
  const number = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(number) && number >= 1 ? number : 1
}

/**
 * 解析用户输入，得到「要看哪个视频的第几 P」。
 *
 * 支持四种写法，因为用户从各处复制来的东西形态不一：
 *   · 完整视频页链接（可带 ?p=2）
 *   · b23.tv 短链（下发短链标记，交给 followShortLink 跟随）
 *   · 单独一个 BV 号（"BV1GJ411x7h7"）
 *   · 单独一个 av 号（"av170001"），或夹在一句中文里的上述两种
 *
 * 返回值：{ bvid?, aid?, page, short?, url? }；非法输入抛 BiliError。
 * 这里不判断「视频是否存在」—— 那是调用 B 站接口的事。
 */
function parseVideoRef(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') {
    throw new BiliError('missing_url', '请先粘贴 B 站视频链接或 BV 号')
  }
  if (text.length > MAX_LINK_LENGTH) {
    throw new BiliError('url_too_long', '链接太长（上限 ' + MAX_LINK_LENGTH + ' 字符）')
  }
  // 其它协议（ftp://、file:// 等）直接拒绝：下面的「无链接就捞 BV 号」兜底不该
  // 让一个非法协议的串混成合法请求
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) {
    throw new BiliError('invalid_url', '只支持 http(s) 链接')
  }

  const urlMatch = URL_IN_TEXT_RE.exec(text)
  if (urlMatch !== null) {
    // 用户可能在同一行里贴了「分享文案 + 链接」，取第一个链接即可
    const url = safeUrl(urlMatch[0].replace(/[)\]}>，。；、]+$/, ''))
    if (url === undefined) {
      throw new BiliError('invalid_url', '无法识别的链接：' + urlMatch[0].slice(0, 120))
    }
    if (!isPlainHttpUrl(url)) {
      throw new BiliError('invalid_url', '只支持 http(s) 的 B 站链接')
    }
    if (!hostMatches(url.hostname, PAGE_HOST_SUFFIXES)) {
      throw new BiliError(
        'host_not_allowed',
        '只支持 bilibili.com / b23.tv / bilibili.tv 的链接（收到 ' + url.hostname + '）',
      )
    }
    // BV 号可能出现在路径里，也可能作为 ?bvid= 查询参数出现，一起搜
    const haystack = decodeURIComponentSafe(url.pathname) + ' ' + decodeURIComponentSafe(url.search)
    const bvid = BV_RE.exec(haystack)
    if (bvid !== null) {
      return { bvid: bvid[0], page: parsePage(url.searchParams.get('p')), url: url.href }
    }
    const aid = AV_RE.exec(haystack)
    if (aid !== null) {
      return { aid: aid[1], page: parsePage(url.searchParams.get('p')), url: url.href }
    }
    if (hostMatches(url.hostname, SHORT_HOST_SUFFIXES)) {
      // b23.tv/xxxx 本身不含 BV 号，只能靠 302 跳转后的真实地址
      return { short: true, page: 1, url: url.href }
    }
    throw new BiliError('no_video_id', '链接里没有找到 BV 号，请复制视频页地址')
  }

  // 没有链接：允许直接贴 BV / av 号（也从整句话里捞）
  const bvid = BV_RE.exec(text)
  if (bvid !== null) return { bvid: bvid[0], page: 1 }
  const aid = AV_RE.exec(text)
  if (aid !== null) return { aid: aid[1], page: 1 }

  throw new BiliError('no_video_id', '没有找到 BV 号或视频链接')
}

/** decodeURIComponent 在坏转义上会抛，这里降级成原文。 */
function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return String(value)
  }
}

/* ------------------------------------------------------------------ *
 * 外呼：JSON 接口
 * ------------------------------------------------------------------ */

/** 判断一个 hostname 是不是 B 站自己的接口域名（用于限制接口外呼目标）。 */
function assertBilibiliApiUrl(url) {
  const parsed = safeUrl(url)
  if (parsed === undefined || parsed.protocol !== 'https:') {
    throw new BiliError('invalid_api_url', '内部错误：接口地址必须是 https')
  }
  if (!hostMatches(parsed.hostname, ['bilibili.com'])) {
    throw new BiliError('invalid_api_url', '内部错误：接口地址必须是 bilibili.com 域名')
  }
  return parsed
}

/**
 * 带超时地取一个 B 站 JSON 接口。
 *
 * 用 AbortController + setTimeout 而不是 AbortSignal.timeout：前者在旧运行时里也
 * 一定存在，而且我们能在 finally 里清掉定时器（否则进程里会残留一个 15s 的 timer）。
 */
async function getBilibiliJson(fetchImpl, url) {
  assertBilibiliApiUrl(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Referer: BILIBILI_REFERER,
          Accept: 'application/json, text/plain, */*',
        },
        redirect: 'follow',
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new BiliError('upstream_timeout', 'B 站接口超时（' + REQUEST_TIMEOUT_MS + 'ms）', 504)
      }
      throw new BiliError('upstream_unreachable', '连接 B 站接口失败：' + messageOf(error), 504)
    }
    if (response === undefined || response === null) {
      throw new BiliError('upstream_unreachable', 'B 站接口没有返回响应', 504)
    }
    if (response.ok !== true) {
      throw new BiliError('upstream_status', 'B 站接口返回 HTTP ' + response.status, 502)
    }
    try {
      return await response.json()
    } catch (error) {
      throw new BiliError('upstream_payload', 'B 站接口返回的不是合法 JSON', 502)
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * 短链：b23.tv → 真实视频页
 * ------------------------------------------------------------------ */

/**
 * 跟随 b23.tv 的跳转，返回最终视频页 URL。
 *
 * 这里用 `redirect: 'follow'` 让 fetch 自己跟，然后读 `response.url`：b23 的跳转
 * 链有 2~3 跳，手写 Location 循环反而更容易踩相对路径的坑。跟完之后必须重新校验
 * 最终主机 —— 短链服务可以把人带到任何地方，不校验就成了 SSRF 入口。
 */
async function followShortLink(fetchImpl, url) {
  const parsed = safeUrl(url)
  if (parsed === undefined || !isAllowedPageUrl(parsed)) {
    throw new BiliError('invalid_url', '短链地址不合法')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response
  try {
    response = await fetchImpl(parsed.href, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Referer: BILIBILI_REFERER },
      redirect: 'follow',
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new BiliError('short_link_timeout', '短链解析超时', 504)
    }
    throw new BiliError('short_link_failed', '短链解析失败：' + messageOf(error), 502)
  } finally {
    clearTimeout(timer)
  }
  // 只需要最终地址，响应体必须显式取消，否则连接会一直挂到超时
  try {
    if (response?.body !== null && response?.body !== undefined) {
      await response.body.cancel()
    }
  } catch {
    /* 取消失败不影响结果 */
  }
  const finalUrl = String(response?.url || '')
  if (finalUrl === '') {
    throw new BiliError('short_link_failed', '短链没有跳到任何地址', 502)
  }
  const final = safeUrl(finalUrl)
  if (final === undefined || !isAllowedPageUrl(final)) {
    // 短链跳到了非 B 站域名：拒绝，并说明原因
    throw new BiliError(
      'short_link_foreign',
      '短链跳转到了非 B 站域名（' + (final?.hostname || '未知') + '），已拒绝',
      400,
    )
  }
  return final.href
}

/* ------------------------------------------------------------------ *
 * 音频流选择
 * ------------------------------------------------------------------ */

/** 只保留「合法、绝对、且落在 CDN 白名单里」的备用地址，去重、限量。 */
function normalizeBackups(list, primaryUrl) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  if (typeof primaryUrl === 'string' && primaryUrl !== '') seen.add(primaryUrl)
  const out = []
  for (const item of list) {
    if (typeof item !== 'string' || item === '') continue
    const url = safeUrl(item)
    if (url === undefined || !isAllowedCdnUrl(url)) continue
    if (seen.has(url.href)) continue
    seen.add(url.href)
    out.push(url.href)
    if (out.length >= MAX_BACKUPS) break
  }
  return out
}

/** 从 playurl 的 payload 里挑一条音频流：DASH 优先，其次 durl。 */
function pickAudioStream(payload) {
  const data = payload && typeof payload === 'object' ? payload : {}
  const dash = data.dash && typeof data.dash === 'object' ? data.dash : {}
  // 普通 DASH 音频、无损 FLAC、杜比全景声分别在不同字段里；都收进来按码率挑。
  const candidates = []
  for (const group of [dash.audio, dash.flac?.audio, dash.dolby?.audio]) {
    // 普通音频是数组；FLAC 的 dash.flac.audio 在部分接口版本里是单个对象，
    // 两种形态都收，避免无损音轨被漏掉
    const list = Array.isArray(group) ? group : group !== null && typeof group === 'object' ? [group] : []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const baseUrl = String(item.baseUrl || item.base_url || '')
      if (baseUrl === '') continue
      candidates.push({
        audioUrl: baseUrl,
        backups: normalizeBackups(item.backupUrl || item.backup_url, baseUrl),
        bandwidth: Number(item.bandwidth) || 0,
        mimeType: String(item.mimeType || item.mime_type || ''),
        codecs: String(item.codecs || ''),
      })
    }
  }
  if (candidates.length > 0) {
    candidates.sort((left, right) => right.bandwidth - left.bandwidth)
    return candidates[0]
  }
  // 老视频 / 部分番剧没有 DASH，只有整段 mp4（durl）
  const durl = Array.isArray(data.durl) ? data.durl : []
  for (const item of durl) {
    if (item === null || typeof item !== 'object') continue
    const baseUrl = String(item.url || '')
    if (baseUrl === '') continue
    return {
      audioUrl: baseUrl,
      backups: normalizeBackups(item.backup_url || item.backupUrl, baseUrl),
      bandwidth: 0,
      mimeType: '',
      codecs: '',
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * 核心：resolve
 * ------------------------------------------------------------------ */

/**
 * 解析一个链接 / BV 号，返回界面需要的全部信息。
 *
 * @param raw 用户输入（链接、短链、BV 号都可能）
 * @param fetchImpl 测试注入点；生产用 globalThis.fetch
 */
async function resolveLink(raw, fetchImpl) {
  let ref = parseVideoRef(raw)
  if (ref.short === true) {
    const finalUrl = await followShortLink(fetchImpl, ref.url)
    ref = parseVideoRef(finalUrl)
    if (ref.short === true) {
      // 短链最终又是个短链（理论上不会），直接认定失败，避免递归
      throw new BiliError('short_link_failed', '短链解析后仍然是短链，无法定位视频', 502)
    }
  }

  const viewQuery =
    ref.bvid !== undefined ? 'bvid=' + encodeURIComponent(ref.bvid) : 'aid=' + encodeURIComponent(ref.aid)
  const view = await getBilibiliJson(
    fetchImpl,
    'https://api.bilibili.com/x/web-interface/view?' + viewQuery,
  )
  const viewCode = Number(view?.code)
  if (viewCode !== 0) {
    // B 站用 -404 / -400 表示视频不存在或参数错；其余按上游失败处理
    if (viewCode === -404 || viewCode === -400) {
      throw new BiliError(
        'video_not_found',
        '视频不存在或不可见：' + String(view?.message || viewCode),
        404,
      )
    }
    throw new BiliError(
      'view_failed',
      '视频信息获取失败：' + String(view?.message || viewCode),
      502,
    )
  }

  const data = view.data && typeof view.data === 'object' ? view.data : {}
  const bvid = String(data.bvid || ref.bvid || '')
  const pages = Array.isArray(data.pages) ? data.pages : []
  // 请求的分 P 可能超过实际分 P 数（用户手改 URL），夹到合法范围
  const page = pages.length > 0 ? Math.min(ref.page, pages.length) : 1
  const pageInfo = pages.length > 0 ? pages[page - 1] : undefined
  let cid = pageInfo?.cid ?? data.cid
  if (cid === undefined || cid === null || cid === '') {
    throw new BiliError('no_cid', '视频没有 cid，无法取音频地址', 502)
  }
  cid = String(cid)

  const baseTitle = String(data.title || data.part || 'B站音频')
  // 多 P 视频把 P 序号拼进标题，否则队列里几条同名分不清
  const title = pages.length > 1 ? baseTitle + ' P' + page : baseTitle
  const duration = Number(pageInfo?.duration ?? data.duration) || 0

  // av 号输入时 view 一般也会回 bvid；万一没有就退回 aid，别拼出空的 bvid 参数
  const playQuery =
    bvid !== ''
      ? 'bvid=' + encodeURIComponent(bvid)
      : 'aid=' + encodeURIComponent(String(data.aid || ref.aid || ''))
  const playUrl =
    'https://api.bilibili.com/x/player/playurl?' +
    playQuery +
    '&cid=' +
    encodeURIComponent(cid) +
    // fnval=16 请求 DASH（音频/视频分离），fourk 与 fnver 是 B 站要求的固定组合
    '&fnval=16&fnver=0&fourk=1'
  const play = await getBilibiliJson(fetchImpl, playUrl)
  const playCode = Number(play?.code)
  if (playCode !== 0) {
    throw new BiliError(
      'playurl_failed',
      '音频地址获取失败：' + String(play?.message || playCode),
      502,
    )
  }
  const stream = pickAudioStream(play.data)
  if (stream === undefined) {
    // 充电专属 / 付费 / 地区限制的常见表现：接口成功但没有音频流
    throw new BiliError(
      'no_audio_stream',
      '这个视频没有可用的音频流（可能是充电专属、付费或地区限制内容）',
      422,
    )
  }
  if (!isAllowedCdnUrl(stream.audioUrl)) {
    // 防御：接口万一返回了非白名单主机，宁可不播也不把代理开成任意 URL 中转
    throw new BiliError('cdn_host_not_allowed', '音频地址不在允许的 CDN 白名单内', 502)
  }

  return {
    title,
    bvid,
    cid,
    duration,
    page,
    pages: pages.length,
    audioUrl: stream.audioUrl,
    backups: stream.backups,
    mimeType: stream.mimeType,
    codecs: stream.codecs,
  }
}

/* ------------------------------------------------------------------ *
 * HTTP 小工具
 * ------------------------------------------------------------------ */

function requestUrl(req) {
  return new URL(req.url || '/', 'http://127.0.0.1')
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // 解析结果与音频地址都带时效，别让浏览器/中间层缓存
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

/** 只允许 GET / HEAD 的接口用它统一挡掉其它方法。 */
function rejectMethod(res, allowed) {
  res.writeHead(405, { Allow: allowed })
  res.end()
}

/**
 * 音频流的响应头拼装。
 *
 * Content-Type 必须改写：B 站 CDN 对 DASH m4s 通常只回 application/octet-stream，
 * Chromium 的 <audio> 遇到未知类型会直接报错，因此统一成 audio/mp4（m4s 就是
 * 分片 MP4，容器里的音频轨能正常解码）。
 */
function normalizeContentType(upstreamType, targetPath) {
  const type = String(upstreamType || '').toLowerCase()
  if (type.startsWith('audio/') || type.startsWith('video/')) return type
  if (type.startsWith('application/octet-stream') || type === '') {
    // m4s 是 DASH 的分片 MP4（只有音轨）；整段 mp4 是老的 durl 回退。两种容器
    // <audio> 都能解出音频轨，但声明的类型要贴合容器，免得启发式嗅探出岔子。
    return /\.mp4$/i.test(String(targetPath || '')) ? 'video/mp4' : 'audio/mp4'
  }
  // 其它类型（text/html 之类）原样保留，让浏览器/调用方能看出上游出错
  return type
}

/** 客户端发来的 Range 原样透传（只透传 Range，别的请求头一个都不转发）。 */
function buildStreamRequestHeaders(rangeHeader) {
  const headers = {
    'User-Agent': USER_AGENT,
    Referer: BILIBILI_REFERER,
    // 音频是已经压过的大块数据；声明 identity 才能保证 Content-Length /
    // Content-Range 与真实字节数一致，否则 Range 偏移会错位。
    'Accept-Encoding': 'identity',
  }
  if (typeof rangeHeader === 'string' && rangeHeader.trim() !== '') {
    headers.Range = rangeHeader.trim()
  }
  return headers
}

/** 背压：res.write 返回 false 时等 drain（或连接被关掉）再继续读上游。 */
function waitForDrain(res) {
  return new Promise((resolve) => {
    if (res.destroyed === true) {
      resolve()
      return
    }
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
  })
}

/** 取消上游响应体；取消失败不影响主流程。 */
async function cancelBody(response) {
  try {
    if (response?.body !== null && response?.body !== undefined) {
      await response.body.cancel()
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * API 实现
 * ------------------------------------------------------------------ */

/**
 * 构造三个 handler。抽成工厂函数是为了测试：单测注入假 fetch、假 req/res，
 * 不联网也能覆盖参数校验、白名单、错误映射与 206 透传。
 */
export function createApi(options = {}) {
  const fetchImpl = options.fetch
  const logger = options.logger

  const warn = (message) => {
    try {
      if (logger !== undefined && typeof logger.warn === 'function') logger.warn(message)
      else console.warn('[bili-audio] ' + message)
    } catch {
      /* 日志失败不能影响主流程 */
    }
  }

  const getFetch = () => {
    if (typeof fetchImpl === 'function') return fetchImpl
    if (typeof globalThis.fetch === 'function') return globalThis.fetch
    // 老运行时里没有 fetch：给一条明确可行动的错误，而不是 "fetch is not a function"
    throw new BiliError(
      'fetch_unavailable',
      '当前 Node 运行时没有全局 fetch，无法请求 B 站接口（需要 Node 18+）',
      500,
    )
  }

  /** GET /health */
  async function health(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      rejectMethod(res, 'GET, HEAD')
      return
    }
    sendJson(res, 200, { ok: true, version: VERSION })
  }

  /** GET /resolve?url=... */
  async function resolve(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      rejectMethod(res, 'GET, HEAD')
      return
    }
    let raw = ''
    try {
      const url = requestUrl(req)
      raw = url.searchParams.get('url') ?? url.searchParams.get('link') ?? ''
      const info = await resolveLink(raw, getFetch())
      sendJson(res, 200, { ok: true, ...info })
    } catch (error) {
      const payload = toErrorPayload(error)
      if (!(error instanceof BiliError)) {
        warn('resolve 失败（' + String(raw).slice(0, 200) + '）：' + messageOf(error))
      }
      sendJson(res, payload.status, payload.body)
    }
  }

  /** GET /stream?u=<urlencoded audio url> */
  async function stream(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      rejectMethod(res, 'GET, HEAD')
      return
    }
    let target
    try {
      const url = requestUrl(req)
      const raw = url.searchParams.get('u') ?? url.searchParams.get('url') ?? ''
      if (raw.trim() === '') {
        throw new BiliError('missing_url', '缺少 u 参数（要代理的音频地址）')
      }
      if (raw.length > MAX_LINK_LENGTH) {
        throw new BiliError('url_too_long', '音频地址太长')
      }
      target = safeUrl(raw)
      if (target === undefined) {
        throw new BiliError('invalid_url', 'u 参数不是合法 URL')
      }
      if (!isAllowedCdnUrl(target)) {
        // 这条是「不开成开放代理」的核心：非 B 站音频 CDN 一律拒绝
        throw new BiliError(
          'host_not_allowed',
          '只允许代理 B 站音频 CDN（收到 ' + target.hostname + '）',
        )
      }
    } catch (error) {
      const payload = toErrorPayload(error)
      sendJson(res, payload.status, payload.body)
      return
    }

    const controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    // 浏览器关闭 <audio> / 换曲时立刻断开上游，不然 CDN 连接会一直挂着
    const onClose = () => controller.abort()
    res.on('close', onClose)

    let upstream
    try {
      upstream = await getFetch()(target.href, {
        method: 'GET',
        headers: buildStreamRequestHeaders(req.headers?.range),
        redirect: 'follow',
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      res.off('close', onClose)
      if (error instanceof BiliError) {
        // getFetch() 抛的「运行时没有 fetch」是 500，别被归到 CDN 连不上
        sendJson(res, error.status, { error: { code: error.code, message: error.message } })
      } else if (controller.signal.aborted) {
        sendJson(res, 504, {
          error: { code: 'upstream_timeout', message: '音频 CDN 超时（' + REQUEST_TIMEOUT_MS + 'ms）' },
        })
      } else {
        sendJson(res, 502, {
          error: { code: 'upstream_unreachable', message: '音频 CDN 连接失败：' + messageOf(error) },
        })
      }
      return
    }
    // 响应头已到，body 可能还要传很久，定时器只负责「连不上」的场景
    clearTimeout(timer)
    timer = undefined

    try {
      if (upstream === undefined || upstream === null) {
        throw new BiliError('upstream_unreachable', '音频 CDN 没有返回响应', 502)
      }
      // 跟随重定向之后必须再校验一次最终主机：CDN 302 到任意域名会变成跳板
      const finalUrl = safeUrl(upstream.url)
      if (finalUrl === undefined || !isAllowedCdnUrl(finalUrl)) {
        await cancelBody(upstream)
        throw new BiliError(
          'host_not_allowed',
          '音频 CDN 跳转到了非白名单主机（' + (finalUrl?.hostname || '未知') + '），已拒绝',
        )
      }
      if (upstream.status === 401 || upstream.status === 403) {
        await cancelBody(upstream)
        throw new BiliError(
          'cdn_forbidden',
          '音频 CDN 拒绝访问（403）：地址可能已过期，请重新解析',
          502,
        )
      }
      if (upstream.status === 404 || upstream.status === 410) {
        await cancelBody(upstream)
        throw new BiliError('cdn_gone', '音频已从 CDN 移除（' + upstream.status + '），请重新解析', 502)
      }
      if (upstream.status >= 400) {
        await cancelBody(upstream)
        throw new BiliError(
          'upstream_status',
          '音频 CDN 返回 HTTP ' + upstream.status,
          502,
        )
      }

      const contentType = normalizeContentType(
        upstream.headers.get('content-type'),
        target.pathname,
      )
      const contentLength = upstream.headers.get('content-length')
      const contentRange = upstream.headers.get('content-range')
      const acceptRanges = upstream.headers.get('accept-ranges')
      const outHeaders = {
        'Content-Type': contentType,
        // 明确告诉 <audio> 可以拖进度条；CDN 支持 Range，但我们对外统一声明
        'Accept-Ranges': acceptRanges || 'bytes',
        // 音频地址有时效，客户端缓存半小时足够，也避免反复走代理
        'Cache-Control': 'private, max-age=1800',
      }
      if (contentLength !== null) outHeaders['Content-Length'] = contentLength
      if (contentRange !== null) outHeaders['Content-Range'] = contentRange

      res.writeHead(upstream.status, outHeaders)

      // HEAD 也不需要 body；有些服务端不支持 HEAD，这里用 GET 拿到头就取消 body
      if (req.method === 'HEAD' || upstream.body === null || upstream.body === undefined) {
        await cancelBody(upstream)
        res.end()
        return
      }

      const reader = upstream.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done === true) break
          if (value === undefined || value === null) continue
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
          if (res.write(chunk) === false) {
            // 客户端读得慢：等它 drain，否则内存里会堆满整首歌
            await waitForDrain(res)
          }
        }
        res.end()
      } finally {
        try {
          reader.releaseLock()
        } catch {
          /* ignore */
        }
      }
    } catch (error) {
      const payload = toErrorPayload(error)
      if (!(error instanceof BiliError)) {
        warn('stream 失败（' + target.hostname + '）：' + messageOf(error))
      }
      if (res.headersSent !== true) {
        sendJson(res, payload.status, payload.body)
      } else {
        // 已经开始回字节了，没法再改状态码；断开让 <audio> 触发 error
        try {
          res.destroy()
        } catch {
          /* ignore */
        }
      }
    } finally {
      res.off('close', onClose)
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  return { health, resolve, stream }
}

/* ------------------------------------------------------------------ *
 * 注册到 DSH
 * ------------------------------------------------------------------ */

/** 把三个 handler 挂到宿主 webServer；注册失败只告警，不拖垮整个插件加载。 */
function registerRoutes(ctx, api) {
  const disposers = []
  const warn = (message) => {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message)
      else console.warn('[bili-audio] ' + message)
    } catch {
      /* ignore */
    }
  }
  const route = (routePath, handler) => {
    try {
      // kind: 'exact' —— 只有路径完全一致才进这个 handler，不做前缀通配，
      // 避免误吃别的插件/宿主自己的路由。
      disposers.push(ctx.webServer.register({ kind: 'exact', path: routePath, handler }))
    } catch (error) {
      warn('路由 ' + routePath + ' 注册失败（已跳过）：' + messageOf(error))
    }
  }

  route(API + '/health', api.health)
  route(API + '/resolve', api.resolve)
  route(API + '/stream', api.stream)

  // 插件卸载 / 热重载时把路由摘掉，否则旧 handler 会一直挂在服务上
  ctx.effect(
    () => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    },
    'bili-audio: routes',
  )
}

export function apply(ctx) {
  const api = createApi({ logger: ctx.logger })
  registerRoutes(ctx, api)
}

/* ------------------------------------------------------------------ *
 * 测试钩子
 * ------------------------------------------------------------------ *
 * 这些内部函数只给 tests 用：单测需要在不联网的情况下验证解析、白名单、
 * 错误映射。它们不是插件 API 的一部分，改名/删除不会被视为破坏性变更。
 */
export const __internals = {
  API,
  MAX_LINK_LENGTH,
  REQUEST_TIMEOUT_MS,
  BiliError,
  parseVideoRef,
  parsePage,
  safeUrl,
  hostMatches,
  isPlainHttpUrl,
  isAllowedPageUrl,
  isAllowedCdnUrl,
  normalizeBackups,
  pickAudioStream,
  normalizeContentType,
  buildStreamRequestHeaders,
  toErrorPayload,
  resolveLink,
}
