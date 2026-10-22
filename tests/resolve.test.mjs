/**
 * resolve：参数校验 + 上游编排 + 错误映射。
 *
 * 全部用注入的假 fetch，不联网也能覆盖「短链跟随」「选最高码率」「备用地址过滤」
 * 「没有音频流」「视频不存在」等分支。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createApi, __internals } from '../lib/index.js'
import { mockRes, jsonResult, fakeHeaders, getRequest } from './helpers.mjs'

const { API } = __internals
const BVID = 'BV1GJ411x7h7'

const VIEW_OK = {
  code: 0,
  data: {
    bvid: BVID,
    cid: 111,
    duration: 240,
    title: '测试视频',
    pages: [
      { cid: 111, duration: 120 },
      { cid: 222, duration: 180 },
    ],
  },
}

const PLAY_OK = {
  code: 0,
  data: {
    dash: {
      audio: [
        {
          baseUrl: 'https://a.bilivideo.com/low.m4s',
          backupUrl: ['https://b.bilivideo.com/low-backup.m4s'],
          bandwidth: 64000,
          mimeType: 'audio/mp4',
          codecs: 'mp4a.40.2',
        },
        {
          baseUrl: 'https://a.bilivideo.com/high.m4s',
          // 故意混入：自身重复、非白名单主机、正常备用
          backupUrl: [
            'https://a.bilivideo.com/high.m4s',
            'https://evil.example/x.m4s',
            'https://c.bilivideo.com/high-backup.m4s',
          ],
          bandwidth: 192000,
          mimeType: 'audio/mp4',
          codecs: 'mp4a.40.2',
        },
      ],
    },
  },
}

/** 按 URL 分流 view / playurl，并记录每次外呼。 */
function biliFetch({ view = VIEW_OK, play = PLAY_OK, calls = [] } = {}) {
  return async (url) => {
    calls.push(url)
    if (url.startsWith('https://api.bilibili.com/x/web-interface/view')) return jsonResult(view)
    if (url.includes('/x/player/playurl')) return jsonResult(play)
    throw new Error('单测没有预期的请求：' + url)
  }
}

test('resolved 成功：选最高码率、过滤非法备用地址、多 P 标题带 P 号', async () => {
  const calls = []
  const api = createApi({ fetch: biliFetch({ calls }) })
  const { res, state, json } = mockRes()
  await api.resolve(getRequest(API + '/resolve', { url: BVID }), res)

  assert.equal(state.status, 200)
  const body = json()
  assert.equal(body.ok, true)
  assert.equal(body.title, '测试视频 P1')
  assert.equal(body.bvid, BVID)
  assert.equal(body.cid, '111')
  assert.equal(body.duration, 120)
  assert.equal(body.page, 1)
  assert.equal(body.pages, 2)
  assert.equal(body.audioUrl, 'https://a.bilivideo.com/high.m4s')
  // 主地址不重复出现；非白名单的备用地址被剔除
  assert.deepEqual(body.backups, ['https://c.bilivideo.com/high-backup.m4s'])
  assert.equal(body.mimeType, 'audio/mp4')

  // playurl 必须带 DASH 参数，否则拿到的是整段 mp4
  assert.equal(calls.length, 2)
  assert.match(calls[1], /[?&]fnval=16(&|$)/)
  assert.match(calls[1], /[?&]cid=111(&|$)/)
  assert.match(calls[1], /[?&]fourk=1(&|$)/)
})

test('多 P：?p=2 取第二 P 的 cid / 时长，标题拼 P2', async () => {
  const api = createApi({ fetch: biliFetch() })
  const { res, state, json } = mockRes()
  const pageUrl = 'https://www.bilibili.com/video/' + BVID + '?p=2'
  await api.resolve(getRequest(API + '/resolve', { url: pageUrl }), res)
  assert.equal(state.status, 200)
  const body = json()
  assert.equal(body.cid, '222')
  assert.equal(body.duration, 180)
  assert.equal(body.page, 2)
  assert.equal(body.title, '测试视频 P2')
})

test('分 P 越界：夹到最后一 P，不报错', async () => {
  const api = createApi({ fetch: biliFetch() })
  const { res, json } = mockRes()
  const pageUrl = 'https://www.bilibili.com/video/' + BVID + '?p=99'
  await api.resolve(getRequest(API + '/resolve', { url: pageUrl }), res)
  assert.equal(json().page, 2)
  assert.equal(json().cid, '222')
})

test('durl 回退：没有 DASH 时用整段 mp4', async () => {
  const play = {
    code: 0,
    data: {
      durl: [
        {
          url: 'https://a.bilivideo.com/durl.mp4',
          backup_url: ['https://b.bilivideo.com/durl-backup.mp4'],
        },
      ],
    },
  }
  const api = createApi({ fetch: biliFetch({ play }) })
  const { res, state, json } = mockRes()
  await api.resolve(getRequest(API + '/resolve', { url: BVID }), res)
  assert.equal(state.status, 200)
  assert.equal(json().audioUrl, 'https://a.bilivideo.com/durl.mp4')
  assert.deepEqual(json().backups, ['https://b.bilivideo.com/durl-backup.mp4'])
})

test('没有音频流：422 no_audio_stream（充电专属/付费的典型表现）', async () => {
  const play = { code: 0, data: { dash: { audio: [] }, durl: [] } }
  const api = createApi({ fetch: biliFetch({ play }) })
  const { res, state, json } = mockRes()
  await api.resolve(getRequest(API + '/resolve', { url: BVID }), res)
  assert.equal(state.status, 422)
  assert.equal(json().error.code, 'no_audio_stream')
})

test('视频不存在：view.code=-404 → 404 video_not_found', async () => {
  const api = createApi({ fetch: biliFetch({ view: { code: -404, message: '啥都木有' } }) })
  const { res, state, json } = mockRes()
  await api.resolve(getRequest(API + '/resolve', { url: BVID }), res)
  assert.equal(state.status, 404)
  assert.equal(json().error.code, 'video_not_found')
})

test('其它 view 错误（如 -412 风控）→ 502 view_failed', async () => {
  const api = createApi({ fetch: biliFetch({ view: { code: -412, message: '请求被拦截' } }) })
  const { res, state, json } = mockRes()
  await api.resolve(getRequest(API + '/resolve', { url: BVID }), res)
  assert.equal(state.status, 502)
  assert.equal(json().error.code, 'view_failed')
})

test('playurl 报错 → 502 playurl_failed', async () => {
  const api = createApi({ fetch: biliFetch({ play: { code: -403, message: '权限不足' } }) })
  const { res, state, json } = mockRes()
  await api.resolve(getRequest(API + '/resolve', { url: BVID }), res)
  assert.equal(state.status, 502)
  assert.equal(json().error.code, 'playurl_failed')
})

test('b23.tv 短链：先跟随跳转再解析', async () => {
  const calls = []
  const fetchFake = async (url) => {
    calls.push(url)
    if (url === 'https://b23.tv/AbCdEfG') {
      return {
        ok: true,
        status: 200,
        url: 'https://www.bilibili.com/video/' + BVID,
        headers: fakeHeaders({}),
        body: { async cancel() {} },
      }
    }
    if (url.startsWith('https://api.bilibili.com/x/web-interface/view')) return jsonResult(VIEW_OK)
    if (url.includes('/x/player/playurl')) return jsonResult(PLAY_OK)
    throw new Error('unexpected ' + url)
  }
  const api = createApi({ fetch: fetchFake })
  const { res, state, json } = mockRes()
  await api.resolve(getRequest(API + '/resolve', { url: 'https://b23.tv/AbCdEfG' }), res)
  assert.equal(state.status, 200)
  assert.equal(json().bvid, BVID)
  assert.equal(calls[0], 'https://b23.tv/AbCdEfG')
})

test('短链跳到非 B 站域名：400 short_link_foreign', async () => {
  const api = createApi({
    fetch: async () => ({
      ok: true,
      status: 200,
      url: 'https://evil.example/phish',
      headers: fakeHeaders({}),
      body: { async cancel() {} },
    }),
  })
  const { res, state, json } = mockRes()
  await api.resolve(getRequest(API + '/resolve', { url: 'https://b23.tv/AbCdEfG' }), res)
  assert.equal(state.status, 400)
  assert.equal(json().error.code, 'short_link_foreign')
})

test('上游网络异常：504 upstream_unreachable', async () => {
  const api = createApi({
    fetch: async () => {
      throw new Error('ENOTFOUND api.bilibili.com')
    },
  })
  const { res, state, json } = mockRes()
  await api.resolve(getRequest(API + '/resolve', { url: BVID }), res)
  assert.equal(state.status, 504)
  assert.equal(json().error.code, 'upstream_unreachable')
})

test('上游 HTTP 错误：502 upstream_status', async () => {
  const api = createApi({ fetch: async () => jsonResult({}, { status: 503 }) })
  const { res, state, json } = mockRes()
  await api.resolve(getRequest(API + '/resolve', { url: BVID }), res)
  assert.equal(state.status, 502)
  assert.equal(json().error.code, 'upstream_status')
})

test('上游返回非法 JSON：502 upstream_payload', async () => {
  const api = createApi({
    fetch: async () => ({
      ok: true,
      status: 200,
      url: 'https://api.bilibili.com/x/web-interface/view',
      headers: fakeHeaders({}),
      body: null,
      async json() {
        throw new Error('Unexpected token <')
      },
    }),
  })
  const { res, state, json } = mockRes()
  await api.resolve(getRequest(API + '/resolve', { url: BVID }), res)
  assert.equal(state.status, 502)
  assert.equal(json().error.code, 'upstream_payload')
})

test('缺少 url 参数：400 missing_url，且不外呼', async () => {
  let called = 0
  const api = createApi({
    fetch: async () => {
      called += 1
      return jsonResult(VIEW_OK)
    },
  })
  const { res, state, json } = mockRes()
  await api.resolve(getRequest(API + '/resolve'), res)
  assert.equal(state.status, 400)
  assert.equal(json().error.code, 'missing_url')
  assert.equal(called, 0)
})

test('非 B 站链接：400 host_not_allowed，且不外呼', async () => {
  let called = 0
  const api = createApi({
    fetch: async () => {
      called += 1
      return jsonResult(VIEW_OK)
    },
  })
  const { res, state, json } = mockRes()
  await api.resolve(
    getRequest(API + '/resolve', { url: 'https://www.youtube.com/watch?v=BV1GJ411x7h7' }),
    res,
  )
  assert.equal(state.status, 400)
  assert.equal(json().error.code, 'host_not_allowed')
  assert.equal(called, 0)
})

test('POST 方法：405', async () => {
  const api = createApi({ fetch: biliFetch() })
  const { res, state } = mockRes()
  await api.resolve({ method: 'POST', url: API + '/resolve?url=' + BVID, headers: {} }, res)
  assert.equal(state.status, 405)
})
