/**
 * 队列 / 最近播放的本地存储，以及播放快捷键。
 *
 * 这些函数住在客户端 bundle 里（浏览器里没有构建步骤，不能再拆一个模块）。
 * 测试通过 factory 上的 __test 钩子调用，不渲染界面。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** 极简 react：factory 开头就会 require('react')，这里不渲染组件。 */
function fakeReact() {
  return {
    createElement() {
      return null
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useRef(value) {
      return { current: value }
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
  }
}

let definition
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
  localStorage: {
    getItem() {
      return null
    },
    setItem() {},
  },
}

await import('../lib/client.js')

const api = definition.factory(() => fakeReact()).__test
const { parseLibrary, serializeLibrary, pushHistory, splitLinks, playbackHotkey } = api

test('存储键按插件 id 分开：偏好和队列不是同一个 key', () => {
  assert.equal(api.PREFS_KEY, 'dsh-bili-audio:prefs')
  assert.equal(api.LIBRARY_KEY, 'dsh-bili-audio:library')
  assert.equal(api.LIBRARY_LIMITS.queue, 100)
  assert.equal(api.LIBRARY_LIMITS.history, 30)
})

test('序列化丢掉音频地址和备用地址', () => {
  const stored = serializeLibrary({
    currentId: 'a',
    position: 12.34,
    items: [
      {
        id: 'a',
        link: 'BV1GJ411x7h7',
        title: '一首歌',
        status: 'ready',
        audioUrl: 'https://a.bilivideo.com/expired.m4s',
        backups: ['https://b.bilivideo.com/also-expired.m4s'],
        bvid: 'BV1GJ411x7h7',
        cid: '137649199',
        duration: 213.2,
      },
    ],
    history: [],
  })
  const text = JSON.stringify(stored)
  assert.equal(text.includes('audioUrl'), false)
  assert.equal(text.includes('bilivideo'), false)
  assert.equal(text.includes('backups'), false)
  assert.equal(stored.v, 1)
  assert.equal(stored.position, 12.3)
  assert.equal(stored.items[0].status, 'ready')
  assert.equal(stored.items[0].duration, 213)
  assert.equal(stored.items[0].link, 'BV1GJ411x7h7')
})

test('解析时即使 JSON 里夹带了音频地址也会清掉', () => {
  const raw = JSON.stringify({
    v: 1,
    currentId: 'a',
    position: 3,
    items: [
      {
        id: 'a',
        link: 'ep1001',
        title: '第一集',
        status: 'ready',
        audioUrl: 'https://a.bilivideo.com/x.m4s',
        backups: ['https://b.bilivideo.com/y.m4s'],
      },
    ],
    history: [{ link: 'ss1', title: '季', playedAt: 5 }],
  })
  const library = parseLibrary(raw)
  assert.equal(library.items[0].audioUrl, '')
  assert.deepEqual(library.items[0].backups, [])
  assert.equal(library.items[0].title, '第一集')
  assert.equal(library.currentId, 'a')
  assert.equal(library.position, 3)
  assert.equal(library.history[0].link, 'ss1')
})

test('坏数据、未知版本、偏好对象都当成空库', () => {
  assert.deepEqual(parseLibrary(''), { items: [], currentId: '', history: [], position: 0 })
  assert.deepEqual(parseLibrary('{'), { items: [], currentId: '', history: [], position: 0 })
  assert.deepEqual(parseLibrary('null'), { items: [], currentId: '', history: [], position: 0 })
  assert.deepEqual(parseLibrary(JSON.stringify({ open: false, volume: 0.4 })), {
    items: [],
    currentId: '',
    history: [],
    position: 0,
  })
  assert.deepEqual(
    parseLibrary(JSON.stringify({ v: 2, items: [{ id: 'a', link: 'BV1GJ411x7h7', title: 'x' }] })),
    { items: [], currentId: '', history: [], position: 0 },
  )
})

test('currentId 对不上时落到第一条，并丢掉进度', () => {
  const library = parseLibrary(
    JSON.stringify({
      v: 1,
      currentId: 'missing',
      position: 40,
      items: [{ id: 'a', link: 'BV1GJ411x7h7', title: '歌' }],
    }),
  )
  assert.equal(library.currentId, 'a')
  assert.equal(library.position, 0)
})

test('失败状态保留错误文案；没有标题的解析中条目恢复成待解析', () => {
  const stored = serializeLibrary({
    items: [
      { id: 'bad', link: 'ep1', title: '坏了', status: 'error', error: '没有音频流' },
      { id: 'wait', link: 'ep2', title: '', status: 'resolving' },
    ],
  })
  assert.equal(stored.items[0].status, 'error')
  assert.equal(stored.items[0].error, '没有音频流')
  assert.equal(stored.items[1].status, 'pending')
  assert.equal(stored.items[1].error, '')
})

test('最近播放按链接去重，新的排到最前，并且有上限', () => {
  let history = []
  history = pushHistory(history, { link: 'a', title: 'A' }, 1)
  history = pushHistory(history, { link: 'b', title: 'B' }, 2)
  history = pushHistory(history, { link: 'a', title: 'A2' }, 3)
  assert.deepEqual(
    history.map((entry) => entry.link),
    ['a', 'b'],
  )
  assert.equal(history[0].title, 'A2')
  assert.equal(history[0].playedAt, 3)
  for (let index = 0; index < 40; index += 1) {
    history = pushHistory(history, { link: 'k' + index, title: 'T' }, index)
  }
  assert.equal(history.length, api.LIBRARY_LIMITS.history)
  assert.equal(history[0].link, 'k39')
})

test('队列超过上限时只保留前面的', () => {
  const items = []
  for (let index = 0; index < api.LIBRARY_LIMITS.queue + 5; index += 1) {
    items.push({ id: 'i' + index, link: 'ep' + index, title: '第' + index })
  }
  const stored = serializeLibrary({ items })
  assert.equal(stored.items.length, api.LIBRARY_LIMITS.queue)
  assert.equal(stored.items[0].link, 'ep0')
})

test('splitLinks 收下番剧 ep/ss 链接和裸编号', () => {
  assert.deepEqual(
    splitLinks('ep327107，SS33622 https://www.bilibili.com/bangumi/play/ep1 BV1GJ411x7h7'),
    ['ep327107', 'ss33622', 'https://www.bilibili.com/bangumi/play/ep1', 'BV1GJ411x7h7'],
  )
})

test('快捷键：空格播放，方向键进退，Shift 切歌；输入框和按钮不劫持空格', () => {
  assert.equal(playbackHotkey({ key: ' ' }), 'toggle')
  assert.equal(playbackHotkey({ key: ' ', repeat: true }), null)
  assert.equal(playbackHotkey({ key: ' ', target: { tagName: 'INPUT' } }), null)
  assert.equal(playbackHotkey({ key: ' ', target: { tagName: 'BUTTON' } }), null)
  assert.equal(
    playbackHotkey({ key: ' ', target: { tagName: 'DIV', getAttribute: (name) => (name === 'role' ? 'button' : null) } }),
    null,
  )
  assert.deepEqual(playbackHotkey({ key: 'ArrowRight' }), { seek: 10 })
  assert.deepEqual(playbackHotkey({ key: 'ArrowLeft' }), { seek: -10 })
  assert.equal(playbackHotkey({ key: 'ArrowRight', shiftKey: true }), 'next')
  assert.equal(playbackHotkey({ key: 'ArrowLeft', shiftKey: true }), 'prev')
  assert.equal(playbackHotkey({ key: 'ArrowRight', target: { tagName: 'INPUT' } }), null)
  assert.equal(playbackHotkey({ key: 'MediaTrackNext' }), 'next')
  assert.equal(playbackHotkey({ key: 'MediaTrackPrevious' }), 'prev')
  assert.equal(playbackHotkey({ key: 'MediaPlayPause' }), 'toggle')
  assert.equal(playbackHotkey({ key: 'ArrowRight', ctrlKey: true }), null)
  assert.equal(playbackHotkey({ key: 'k' }), null)
})
