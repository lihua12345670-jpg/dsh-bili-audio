/**
 * 真实网络冒烟测试（不依赖 DSH 宿主）。
 *
 * 用 node:http 起一个最小服务器，把 lib/index.js 的三个 handler 原样挂上去，
 * 然后：
 *   1. /health 是否 OK；
 *   2. 公开视频 BV1GJ411x7h7 能否 resolve 出 audioUrl；
 *   3. 通过 /stream 代理拉前 200 KB，断言 200/206 且 Content-Type 是 audio/*；
 *   4. 反向用例：非白名单主机 400、缺参数 400。
 *
 * 运行：node scripts/smoke.mjs
 * 退出码 0 = 全部通过；1 = 有断言失败（会打印 FAIL 行）。
 */
import { createServer } from 'node:http'

import { createApi, __internals } from '../lib/index.js'

const API = __internals.API
const VIDEO = process.env.BILI_SMOKE_BVID || 'BV1GJ411x7h7'
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
  expect(typeof resolveBody.audioUrl === 'string' && resolveBody.audioUrl !== '', '拿到 audioUrl')
  expect(
    resolveBody.audioUrl !== undefined && __internals.isAllowedCdnUrl(resolveBody.audioUrl),
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
