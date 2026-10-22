/**
 * stream 反向代理的守门与透传。
 *
 * 两条主线：
 *   1. 白名单：只代理 B 站音频 CDN，不能变成开放代理；
 *   2. 透传：Range 进去、206 出来，Content-Range / Accept-Ranges / Content-Type
 *      都按 <audio> 需要的样子回给浏览器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createApi, __internals } from '../lib/index.js'
import { mockRes, fakeHeaders, audioResult, webStream, getRequest } from './helpers.mjs'

const { isAllowedCdnUrl, normalizeContentType, buildStreamRequestHeaders, API } = __internals

/* ------------------------------------------------------------------ *
 * 白名单
 * ------------------------------------------------------------------ */

test('允许的音频 CDN 主机', () => {
  const allowed = [
    'https://cn-xj-ct-01-05.bilivideo.com/upgcxcode/99/91/1/1_da2-1-30280.m4s',
    // mcdn 地址带高位端口（实测 8082），端口不该导致拒绝
    'https://xy113x207x85x219xy.mcdn.bilivideo.cn:8082/v1/resource/upgcxcode/1.m4s',
    'https://upos-sz-mirrorcoso1.bilivideo.com/x.m4s',
    'https://foo.akamaized.net/audio/x.m4s',
    'https://api.bilibili.com/x/player/playurl',
    'http://a.bilivideo.com/x.m4s',
  ]
  for (const url of allowed) {
    assert.equal(isAllowedCdnUrl(url), true, '应该允许：' + url)
  }
})

test('拒绝的非 CDN 主机（开放代理防线）', () => {
  const rejected = [
    'https://evil.example/x.m4s',
    'https://bilivideo.com.evil.example/x.m4s',
    'https://evilbilivideo.com/x.m4s',
    'https://bilivideo.com@evil.example/x.m4s',
    'https://user:pass@a.bilivideo.com/x.m4s',
    'ftp://a.bilivideo.com/x.m4s',
    'file:///C:/Windows/win.ini',
    'http://127.0.0.1/x.m4s',
    'http://[::1]/x.m4s',
    'data:text/plain,hi',
    'javascript:alert(1)',
    'a.bilivideo.com/x.m4s',
    '',
  ]
  for (const url of rejected) {
    assert.equal(isAllowedCdnUrl(url), false, '应该拒绝：' + JSON.stringify(url))
  }
})

test('发给 CDN 的请求头只带必要字段', () => {
  const headers = buildStreamRequestHeaders('bytes=1024-2047')
  assert.equal(headers.Range, 'bytes=1024-2047')
  assert.equal(headers.Referer, 'https://www.bilibili.com/')
  assert.match(headers['User-Agent'], /Windows NT 10\.0/)
  assert.equal(headers['Accept-Encoding'], 'identity')
  // 客户端其它头（Cookie / Authorization 之类）不能顺手带给 CDN
  assert.deepEqual(Object.keys(headers).sort(), [
    'Accept-Encoding',
    'Range',
    'Referer',
    'User-Agent',
  ])
})

test('Content-Type 归一：octet-stream 的 m4s 改写成 audio/mp4', () => {
  assert.equal(normalizeContentType('application/octet-stream', '/x/1.m4s'), 'audio/mp4')
  assert.equal(normalizeContentType('', '/x/1.m4s'), 'audio/mp4')
  assert.equal(normalizeContentType('application/octet-stream', '/x/1.mp4'), 'video/mp4')
  // 上游已经明确声明媒体类型时不要覆盖
  assert.equal(normalizeContentType('audio/mp4', '/x/1.m4s'), 'audio/mp4')
  assert.equal(normalizeContentType('video/mp4', '/x/1.mp4'), 'video/mp4')
  // 明显不是媒体的（上游报错页）原样保留，别伪装成音频
  assert.equal(normalizeContentType('text/html', '/x/1.m4s'), 'text/html')
})

/* ------------------------------------------------------------------ *
 * handler 级
 * ------------------------------------------------------------------ */

test('缺少 u 参数：400 missing_url（错误 JSON 形状固定）', async () => {
  const api = createApi({ fetch: async () => audioResult(Buffer.from('x')) })
  const { res, state, json } = mockRes()
  await api.stream(getRequest(API + '/stream'), res)
  assert.equal(state.status, 400)
  assert.deepEqual(json(), {
    error: { code: 'missing_url', message: '缺少 u 参数（要代理的音频地址）' },
  })
})

test('非白名单主机：400 host_not_allowed，且不会外呼', async () => {
  let called = 0
  const api = createApi({
    fetch: async () => {
      called += 1
      return audioResult(Buffer.from('x'))
    },
  })
  const { res, state, json } = mockRes()
  await api.stream(getRequest(API + '/stream', { u: 'https://evil.example/a.m4s' }), res)
  assert.equal(state.status, 400)
  assert.equal(json().error.code, 'host_not_allowed')
  assert.equal(called, 0, '被拒绝的地址不能真的发出去')
})

test('206 透传：Range 进、Content-Range / Accept-Ranges / 字节原样出', async () => {
  const payload = Buffer.alloc(300, 7)
  const calls = []
  const cdnUrl = 'https://cn-xj-ct-01-05.bilivideo.com/audio.m4s'
  const api = createApi({
    fetch: async (url, init) => {
      calls.push({ url, init })
      return audioResult(payload, {
        status: 206,
        url,
        headers: {
          'content-range': 'bytes 0-299/3000',
          'accept-ranges': 'bytes',
          'content-length': '300',
          'content-type': 'application/octet-stream',
        },
      })
    },
  })
  const { res, state, text } = mockRes()
  const request = getRequest(API + '/stream', { u: cdnUrl }, { range: 'bytes=0-299' })
  await api.stream(request, res)

  assert.equal(calls.length, 1)
  // Range 必须原样透传给 CDN，否则拖进度条会从头开始
  assert.equal(calls[0].init.headers.Range, 'bytes=0-299')
  assert.equal(calls[0].init.headers.Referer, 'https://www.bilibili.com/')
  assert.equal(state.status, 206)
  assert.equal(state.headers['Content-Range'], 'bytes 0-299/3000')
  assert.equal(state.headers['Accept-Ranges'], 'bytes')
  assert.equal(state.headers['Content-Length'], '300')
  // CDN 回的是 Octet-Stream，必须改写，否则 <audio> 不认
  assert.equal(state.headers['Content-Type'], 'audio/mp4')
  assert.equal(text().length, 300)
  assert.deepEqual(Buffer.from(text()), payload)
  assert.equal(state.ended, true)
})

test('不带 Range 的整段请求：200 且保留 Content-Length', async () => {
  const payload = Buffer.from('0123456789')
  const api = createApi({
    fetch: async (url) =>
      audioResult(payload, {
        status: 200,
        url,
        headers: { 'content-length': '10', 'content-type': 'audio/mp4' },
      }),
  })
  const { res, state, text } = mockRes()
  await api.stream(getRequest(API + '/stream', { u: 'https://a.bilivideo.com/x.m4s' }), res)
  assert.equal(state.status, 200)
  assert.equal(state.headers['Content-Length'], '10')
  assert.equal(state.headers['Content-Type'], 'audio/mp4')
  assert.equal(text(), '0123456789')
})

test('CDN 403：映射成 502 cdn_forbidden（客户端据此提示重新解析）', async () => {
  const api = createApi({
    fetch: async (url) => ({
      ok: false,
      status: 403,
      url,
      headers: fakeHeaders({}),
      body: webStream(Buffer.from('forbidden')),
    }),
  })
  const { res, state, json } = mockRes()
  await api.stream(getRequest(API + '/stream', { u: 'https://a.bilivideo.com/x.m4s' }), res)
  assert.equal(state.status, 502)
  assert.equal(json().error.code, 'cdn_forbidden')
})

test('CDN 410：映射成 502 cdn_gone', async () => {
  const api = createApi({
    fetch: async (url) => ({
      ok: false,
      status: 410,
      url,
      headers: fakeHeaders({}),
      body: webStream(Buffer.from('gone')),
    }),
  })
  const { res, state, json } = mockRes()
  await api.stream(getRequest(API + '/stream', { u: 'https://a.bilivideo.com/x.m4s' }), res)
  assert.equal(state.status, 502)
  assert.equal(json().error.code, 'cdn_gone')
})

test('CDN 302 到非白名单主机：拒绝并取消响应体（防跳板）', async () => {
  let cancelled = false
  const api = createApi({
    fetch: async () => ({
      ok: true,
      status: 200,
      url: 'https://evil.example/stolen.m4s',
      headers: fakeHeaders({ 'content-type': 'audio/mp4' }),
      body: {
        getReader() {
          throw new Error('不该读 body')
        },
        async cancel() {
          cancelled = true
        },
      },
    }),
  })
  const { res, state, json } = mockRes()
  await api.stream(getRequest(API + '/stream', { u: 'https://a.bilivideo.com/x.m4s' }), res)
  assert.equal(state.status, 400)
  assert.equal(json().error.code, 'host_not_allowed')
  assert.equal(cancelled, true)
})

test('上游连不上：502 upstream_unreachable', async () => {
  const api = createApi({
    fetch: async () => {
      throw new Error('ECONNRESET')
    },
  })
  const { res, state, json } = mockRes()
  await api.stream(getRequest(API + '/stream', { u: 'https://a.bilivideo.com/x.m4s' }), res)
  assert.equal(state.status, 502)
  assert.equal(json().error.code, 'upstream_unreachable')
  assert.match(json().error.message, /ECONNRESET/)
})

test('HEAD：返回同样的头但不回字节', async () => {
  const payload = Buffer.alloc(64, 1)
  const api = createApi({
    fetch: async (url) =>
      audioResult(payload, { status: 206, url, headers: { 'content-range': 'bytes 0-63/64' } }),
  })
  const { res, state, text } = mockRes()
  const request = { ...getRequest(API + '/stream', { u: 'https://a.bilivideo.com/x.m4s' }), method: 'HEAD' }
  await api.stream(request, res)
  assert.equal(state.status, 206)
  assert.equal(state.headers['Content-Range'], 'bytes 0-63/64')
  assert.equal(text(), '')
  assert.equal(state.ended, true)
})

test('非 GET/HEAD 方法：405', async () => {
  const api = createApi({ fetch: async () => audioResult(Buffer.from('x')) })
  const { res, state } = mockRes()
  await api.stream({ method: 'POST', url: API + '/stream', headers: {} }, res)
  assert.equal(state.status, 405)
  assert.equal(state.headers.Allow, 'GET, HEAD')
})

test('health：{ok:true, version}', async () => {
  const api = createApi({})
  const { res, state, json } = mockRes()
  await api.health(getRequest(API + '/health'), res)
  assert.equal(state.status, 200)
  assert.equal(json().ok, true)
  assert.match(json().version, /^\d+\.\d+\.\d+$/)
})
