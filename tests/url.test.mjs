/**
 * 输入解析与页面域名白名单。
 *
 * 这一组用例守的是「解析入口」：用户粘贴的东西必须被稳妥地归成
 * 「BV 号 / av 号 / 短链 / 非法」四类，任何非 B 站域名都不能混进来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { VERSION, __internals } from '../lib/index.js'

const { parseVideoRef, parsePage, isAllowedPageUrl, BiliError } = __internals

/** 断言某个输入解析失败，并带上指定错误码。 */
function expectCode(raw, code) {
  assert.throws(
    () => parseVideoRef(raw),
    (error) => {
      assert.ok(error instanceof BiliError, '应该是 BiliError，实际是 ' + error?.name)
      assert.equal(error.code, code)
      return true
    },
    '输入 ' + JSON.stringify(raw) + ' 应该报 ' + code,
  )
}

test('裸 BV 号：直接识别为 bvid', () => {
  const ref = parseVideoRef('BV1GJ411x7h7')
  assert.deepEqual(ref, { bvid: 'BV1GJ411x7h7', page: 1 })
})

test('BV 号夹在中文句子里也能捞出来', () => {
  const ref = parseVideoRef('这首歌不错 BV1GJ411x7h7 你听听')
  assert.equal(ref.bvid, 'BV1GJ411x7h7')
})

test('裸 av 号识别成 aid（不误伤 nav123 这类单词）', () => {
  assert.deepEqual(parseVideoRef('av170001'), { aid: '170001', page: 1 })
  // "nav123" 里的 av 前面是字母，没有词边界，不能被当成 av 号
  expectCode('nav123', 'no_video_id')
})

test('视频页链接：带 ?p= 时取到对应分 P', () => {
  const ref = parseVideoRef('https://www.bilibili.com/video/BV1GJ411x7h7?p=3')
  assert.equal(ref.bvid, 'BV1GJ411x7h7')
  assert.equal(ref.page, 3)
})

test('视频页链接：结尾带分享文案的标点也能解析', () => {
  const ref = parseVideoRef('分享视频 https://www.bilibili.com/video/BV1GJ411x7h7，一起听')
  assert.equal(ref.bvid, 'BV1GJ411x7h7')
})

test('?bvid= 形式的链接（播放器页）也能认出 BV', () => {
  const ref = parseVideoRef('https://www.bilibili.com/blackboard/activity-x.html?bvid=BV1GJ411x7h7')
  assert.equal(ref.bvid, 'BV1GJ411x7h7')
})

test('av 号链接：/video/av170001 取到 aid', () => {
  const ref = parseVideoRef('https://www.bilibili.com/video/av170001')
  assert.equal(ref.aid, '170001')
})

test('b23.tv 短链：标记为 short，交给后续跟随跳转', () => {
  const ref = parseVideoRef('https://b23.tv/AbCdEfG')
  assert.equal(ref.short, true)
  assert.equal(ref.url, 'https://b23.tv/AbCdEfG')
})

test('bilibili.tv 也属于允许的页面域名', () => {
  const ref = parseVideoRef('https://www.bilibili.tv/en/video/BV1GJ411x7h7')
  assert.equal(ref.bvid, 'BV1GJ411x7h7')
  assert.equal(isAllowedPageUrl('https://www.bilibili.tv/en/video/x'), true)
})

test('非 B 站链接一律拒绝（即使里面带了合法 BV 号）', () => {
  expectCode('https://www.youtube.com/watch?v=BV1GJ411x7h7', 'host_not_allowed')
  expectCode('https://evil.example/BV1GJ411x7h7', 'host_not_allowed')
})

test('后缀白名单不能被 "bilibili.com.evil.com" 这种域名绕过', () => {
  expectCode('https://bilibili.com.evil.example/video/BV1GJ411x7h7', 'host_not_allowed')
  assert.equal(isAllowedPageUrl('https://bilibili.com.evil.example/x'), false)
  assert.equal(isAllowedPageUrl('https://www.bilibili.com/video/BV1GJ411x7h7'), true)
  assert.equal(isAllowedPageUrl('https://b23.tv/x'), true)
})

test('空输入 / 只有空白：missing_url', () => {
  expectCode('', 'missing_url')
  expectCode('   ', 'missing_url')
  expectCode(undefined, 'missing_url')
})

test('垃圾文本：no_video_id', () => {
  expectCode('这不是链接', 'no_video_id')
  expectCode('https://example.com/', 'host_not_allowed')
})

test('超长输入：url_too_long（防止拿超长串打日志）', () => {
  expectCode('https://www.bilibili.com/video/BV1GJ411x7h7?x=' + 'a'.repeat(5000), 'url_too_long')
})

test('非 http(s) 协议：invalid_url', () => {
  expectCode('ftp://www.bilibili.com/video/BV1GJ411x7h7', 'invalid_url')
})

test('带内嵌凭据的 URL 被拒绝（防 SSRF 混淆）', () => {
  expectCode('https://user:pass@www.bilibili.com/video/BV1GJ411x7h7', 'invalid_url')
})

test('番剧 ep 播放页', () => {
  const ref = parseVideoRef('https://www.bilibili.com/bangumi/play/ep327107')
  assert.equal(ref.kind, 'bangumi')
  assert.equal(ref.epId, '327107')
  assert.equal(ref.seasonId, undefined)
})

test('番剧 ss 播放页，?ep_id= 覆盖到具体一集', () => {
  const season = parseVideoRef('https://www.bilibili.com/bangumi/play/ss33622/')
  assert.equal(season.kind, 'bangumi')
  assert.equal(season.seasonId, '33622')
  assert.equal(season.epId, undefined)
  const pointed = parseVideoRef('https://m.bilibili.com/bangumi/play/ss33622?ep_id=327108')
  assert.equal(pointed.seasonId, '33622')
  assert.equal(pointed.epId, '327108')
})

test('番剧媒体页 md、旧站 /anime/、hash 里的集数', () => {
  const media = parseVideoRef('https://www.bilibili.com/bangumi/media/md28229051')
  assert.equal(media.mediaId, '28229051')
  assert.equal(media.epId, undefined)
  const anime = parseVideoRef('https://bangumi.bilibili.com/anime/28229051/play#327107')
  assert.equal(anime.mediaId, '28229051')
  assert.equal(anime.epId, '327107')
})

test('b23.tv/ep 与 b23.tv/ss 直接当成番剧编号，其它短链仍要跟随跳转', () => {
  const episode = parseVideoRef('https://b23.tv/ep327107')
  assert.equal(episode.kind, 'bangumi')
  assert.equal(episode.epId, '327107')
  assert.equal(episode.short, undefined)
  const season = parseVideoRef('https://b23.tv/ss33622')
  assert.equal(season.seasonId, '33622')
  const opaque = parseVideoRef('https://b23.tv/AbCdEfG')
  assert.equal(opaque.short, true)
})

test('裸 ep / ss 整段匹配；夹在句子里的不误抓', () => {
  assert.deepEqual(parseVideoRef('ep327107'), { kind: 'bangumi', epId: '327107' })
  assert.deepEqual(parseVideoRef('SS33622'), { kind: 'bangumi', seasonId: '33622' })
  expectCode('去看 ep327107 吧', 'no_video_id')
})

test('直播 / 课堂 / 空间 / 专栏 / 音频区：unsupported_link，而不是「没有 BV」', () => {
  expectCode('https://live.bilibili.com/123', 'unsupported_link')
  expectCode('https://www.bilibili.com/cheese/play/ep123', 'unsupported_link')
  expectCode('https://space.bilibili.com/1', 'unsupported_link')
  expectCode('https://www.bilibili.com/read/cv123', 'unsupported_link')
  expectCode('https://www.bilibili.com/audio/au123', 'unsupported_link')
  expectCode('https://www.bilibili.com/bangumi/index', 'unsupported_link')
})

test('parsePage：非法分 P 收敛到 1', () => {
  assert.equal(parsePage('2'), 2)
  assert.equal(parsePage('0'), 1)
  assert.equal(parsePage('-3'), 1)
  assert.equal(parsePage('abc'), 1)
  assert.equal(parsePage(undefined), 1)
})

test('插件基本元数据：API 前缀与版本号', () => {
  assert.equal(__internals.API, '/bili-audio/api')
  assert.match(VERSION, /^\d+\.\d+\.\d+$/)
})
