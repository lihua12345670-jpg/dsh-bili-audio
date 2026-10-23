/**
 * 真实网络冒烟测试（不依赖 DSH 宿主）。
 *
 * 用 node:http 起一个最小服务器，把 lib/index.js 的三个 handler 原样挂上去，
 * 然后：
 *   1. /health 是否 OK；
 *   2. 公开视频 BV1GJ411x7h7 能否 resolve 出 audioUrl；
 *   3. 通过 /stream 代理拉前 200 KB，断言 200/206 且 Content-Type 是 audio/*；
 *   4. 反向用例：非白名单主机 400、缺参数 400；
 *   5. 公开番剧 ep / ss 能解析出白名单内的音频地址；
 *   6. 课堂链接返回 unsupported_link，且不依赖上游是否在线（本地就拒绝）。
 *
 * 运行：node scripts/smoke.mjs
 * 退出码 0 = 全部通过；1 = 有断言失败（会打印 FAIL 行）。
 */
import { createServer } from 'node:http'

import { createApi, __internals } from '../lib/index.js'

const API = __internals.API
const VIDEO = process.env.BILI_SMOKE_BVID || 'BV1GJ411x7h7'
const BANGUMI_EP = process.env.BILI_SMOKE_EP || 'https://www.bilibili.com/bangumi/play/ep327107'
const BANGUMI_SS = process.env.BILI_SMOKE_SS || 'https://www.bilibili.com/bangumi/play/ss33622'
const RANGE_BYTES = 200 * 1024
const REQUEST_TIMEOUT_MS = 25_000

const checks = []

function pass(message) {
  checks.push({ ok: true, message })
  console.log('  PASS  ' + message)
}

function fail(message) {
  checks.push({ ok: false, message })
  console.log('  FAIL  ' + message)
}

function expect(condition, message) {
  if (condition) pass(message)
  else fail(message)
}

const api = createApi()

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === API + '/health') return await api.health(req, res)
    if (url.pathname === API + '/resolve') return await api.resolve(req, res)
    if (url.pathname === API + '/stream') return await api.stream(req, res)
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }))
  } catch (error) {
    console.error('服务器异常：', error)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { code: 'internal_error', message: String(error) } }))
    } else {
      res.destroy()
    }
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

/** 带超时的 fetch：冒烟脚本不该无限挂着。 */
function timedFetch(url, init) {
  return fetch(url, { ...(init || {}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
}

console.log('冒烟测试入口：' + base)
console.log('目标视频：' + VIDEO)

try {
  /* ------------------------------------------------------------------ *
   * 1. health
   * ------------------------------------------------------------------ */
  console.log('\n[1] GET ' + API + '/health')
  const healthResponse = await timedFetch(base + API + '/health')
  const health = await healthResponse.json()
  expect(healthResponse.status === 200, 'health 返回 200（实际 ' + healthResponse.status + '）')
  expect(health.ok === true, 'health.ok === true')
  expect(typeof health.version === 'string', 'health.version 是字符串（' + health.version + '）')

  /* ------------------------------------------------------------------ *
   * 2. resolve
   * ------------------------------------------------------------------ */
  console.log('\n[2] GET ' + API + '/resolve?url=' + VIDEO)
  const resolveResponse = await timedFetch(
    base + API + '/resolve?url=' + encodeURIComponent(VIDEO),
  )
  const resolveBody = await resolveResponse.json()
  console.log(
    '     status=' + resolveResponse.status,
    'title=' + JSON.stringify(resolveBody.title),
    'bvid=' + resolveBody.bvid,
    'cid=' + resolveBody.cid,
    'duration=' + resolveBody.duration,
  )
  expect(resolveResponse.status === 200, 'resolve 返回 200（实际 ' + resolveResponse.status + '）')
  expect(resolveBody.ok === true, 'resolve.ok === true')
  const hasAudio = typeof resolveBody.audioUrl === 'string' && resolveBody.audioUrl !== ''
  expect(hasAudio, '拿到 audioUrl')
  if (!hasAudio) {
    const code = resolveBody.error && resolveBody.error.code
    fail('跳过 stream：resolve 没有 audioUrl（' + code + ' ' + (resolveBody.error && resolveBody.error.message) + '）')
  } else {
  expect(
    __internals.isAllowedCdnUrl(resolveBody.audioUrl),
    'audioUrl 落在 CDN 白名单内（' + new URL(resolveBody.audioUrl).host + '）',
  )
  expect(Array.isArray(resolveBody.backups), 'backups 是数组（' + resolveBody.backups.length + ' 个）')

  /* ------------------------------------------------------------------ *
   * 3. stream：Range 拉前 200KB
   * ------------------------------------------------------------------ */
  const streamPath =
    base + API + '/stream?u=' + encodeURIComponent(resolveBody.audioUrl)
  console.log('\n[3] GET ' + API + '/stream?u=<audioUrl>  Range: bytes=0-' + (RANGE_BYTES - 1))
  const streamResponse = await timedFetch(streamPath, {
    headers: { Range: 'bytes=0-' + (RANGE_BYTES - 1) },
  })
  const contentType = streamResponse.headers.get('content-type') || ''
  const contentRange = streamResponse.headers.get('content-range')
  const acceptRanges = streamResponse.headers.get('accept-ranges')
  const buffer = Buffer.from(await streamResponse.arrayBuffer())
  console.log(
    '     status=' + streamResponse.status,
    'content-type=' + contentType,
    'content-range=' + contentRange,
    'accept-ranges=' + acceptRanges,
    'bytes=' + buffer.length,
  )
  expect(
    streamResponse.status === 200 || streamResponse.status === 206,
    'stream 返回 200 或 206（实际 ' + streamResponse.status + '）',
  )
  expect(contentType.toLowerCase().startsWith('audio/'), 'Content-Type 是 audio/*（' + contentType + '）')
  expect(buffer.length > 100 * 1024, '实际收到 >100KB 音频字节（' + buffer.length + ' 字节）')
  expect(acceptRanges === 'bytes', 'Accept-Ranges: bytes（实际 ' + acceptRanges + '）')
  if (streamResponse.status === 206) {
    expect(
      typeof contentRange === 'string' && contentRange.startsWith('bytes 0-'),
      '206 带 Content-Range（' + contentRange + '）',
    )
  }
  // mp4/m4s 容器开头一般是 ....ftyp，用它确认拿到的确实是媒体字节而不是错误页
  const signature = buffer.subarray(4, 12).toString('latin1')
  console.log('     前 12 字节：' + buffer.subarray(0, 12).toString('hex') + '  (' + signature + ')')
  expect(buffer.includes(Buffer.from('ftyp')), '字节里能找到 MP4 的 ftyp box')
  }

  /* ------------------------------------------------------------------ *
   * 4. 反向用例：白名单与参数校验
   * ------------------------------------------------------------------ */
  console.log('\n[4] 反向用例')
  const evilResponse = await timedFetch(
    base + API + '/stream?u=' + encodeURIComponent('https://evil.example/a.m4s'),
  )
  const evilBody = await evilResponse.json()
  expect(evilResponse.status === 400, '非白名单主机返回 400（实际 ' + evilResponse.status + '）')
  expect(
    evilBody.error !== undefined && evilBody.error.code === 'host_not_allowed',
    '错误码 host_not_allowed（实际 ' + (evilBody.error && evilBody.error.code) + '）',
  )

  const missingResponse = await timedFetch(base + API + '/resolve')
  const missingBody = await missingResponse.json()
  expect(missingResponse.status === 400, '缺 url 参数返回 400（实际 ' + missingResponse.status + '）')
  expect(
    missingBody.error !== undefined && missingBody.error.code === 'missing_url',
    '错误码 missing_url（实际 ' + (missingBody.error && missingBody.error.code) + '）',
  )

  /* ------------------------------------------------------------------ *
   * 5. 番剧 ep / ss：公开正片应能拿到音频地址
   * ------------------------------------------------------------------ */
  console.log('\n[5] 番剧 ep / ss')
  const episodeResponse = await timedFetch(
    base + API + '/resolve?url=' + encodeURIComponent(BANGUMI_EP),
  )
  const episodeBody = await episodeResponse.json()
  console.log(
    '     ep status=' + episodeResponse.status,
    'title=' + JSON.stringify(episodeBody.title),
    'epId=' + episodeBody.epId,
    'duration=' + episodeBody.duration,
    'code=' + (episodeBody.error && episodeBody.error.code),
  )
  expect(episodeResponse.status === 200, '番剧 ep 返回 200（实际 ' + episodeResponse.status + '）')
  expect(episodeBody.ok === true, '番剧 ep ok === true')
  expect(typeof episodeBody.epId === 'string' && episodeBody.epId !== '', '番剧 ep 带 epId')
  expect(
    episodeBody.duration > 60 && episodeBody.duration < 20000,
    '番剧时长是秒而不是毫秒（' + episodeBody.duration + '）',
  )
  expect(
    typeof episodeBody.audioUrl === 'string' && __internals.isAllowedCdnUrl(episodeBody.audioUrl),
    '番剧 audioUrl 落在 CDN 白名单内',
  )
  // 有的网络上 x/web-interface/view 会 412，番剧这条仍能用来确认代理本身。
  const episodeStream = await timedFetch(
    base + API + '/stream?u=' + encodeURIComponent(episodeBody.audioUrl),
    { headers: { Range: 'bytes=0-' + (RANGE_BYTES - 1) } },
  )
  const episodeBytes = Buffer.from(await episodeStream.arrayBuffer())
  const episodeType = episodeStream.headers.get('content-type') || ''
  console.log(
    '     ep stream status=' + episodeStream.status,
    'type=' + episodeType,
    'bytes=' + episodeBytes.length,
  )
  expect(
    episodeStream.status === 200 || episodeStream.status === 206,
    '番剧 stream 返回 200 或 206（实际 ' + episodeStream.status + '）',
  )
  // 有的 CDN 对音轨 mp4 回 video/mp4；<audio> 能解，不要把它当成失败。
  const episodeTypeOk =
    episodeType.toLowerCase().startsWith('audio/') || episodeType.toLowerCase().startsWith('video/mp4')
  expect(episodeTypeOk, '番剧 Content-Type 是 audio/* 或 video/mp4（' + episodeType + '）')
  expect(episodeBytes.includes(Buffer.from('ftyp')), '番剧音频里能找到 MP4 的 ftyp box')

  const seasonResponse = await timedFetch(
    base + API + '/resolve?url=' + encodeURIComponent(BANGUMI_SS),
  )
  const seasonBody = await seasonResponse.json()
  console.log(
    '     ss status=' + seasonResponse.status,
    'title=' + JSON.stringify(seasonBody.title),
    'epId=' + seasonBody.epId,
    'page=' + seasonBody.page + '/' + seasonBody.pages,
  )
  expect(seasonResponse.status === 200, '番剧 ss 返回 200（实际 ' + seasonResponse.status + '）')
  expect(seasonBody.ok === true && seasonBody.page === 1, 'ss 从第一集正片开始')
  expect(
    typeof seasonBody.audioUrl === 'string' && __internals.isAllowedCdnUrl(seasonBody.audioUrl),
    'ss 的 audioUrl 落在 CDN 白名单内',
  )

  /* ------------------------------------------------------------------ *
   * 6. 不支持的链接：本地拒绝，错误码明确
   * ------------------------------------------------------------------ */
  console.log('\n[6] 不支持的链接')
  const cheeseResponse = await timedFetch(
    base + API + '/resolve?url=' + encodeURIComponent('https://www.bilibili.com/cheese/play/ep1'),
  )
  const cheeseBody = await cheeseResponse.json()
  expect(cheeseResponse.status === 400, '课堂链接返回 400（实际 ' + cheeseResponse.status + '）')
  expect(
    cheeseBody.error !== undefined && cheeseBody.error.code === 'unsupported_link',
    '错误码 unsupported_link（实际 ' + (cheeseBody.error && cheeseBody.error.code) + '）',
  )
} catch (error) {
  fail('冒烟脚本异常：' + (error instanceof Error ? error.stack || error.message : String(error)))
} finally {
  await new Promise((resolve) => server.close(resolve))
}

const failed = checks.filter((entry) => !entry.ok)
console.log('\n==== 结果：' + (checks.length - failed.length) + '/' + checks.length + ' 通过 ====')
if (failed.length > 0) {
  for (const entry of failed) console.log('  FAILED: ' + entry.message)
  process.exitCode = 1
} else {
  console.log('冒烟测试全部通过。')
}
