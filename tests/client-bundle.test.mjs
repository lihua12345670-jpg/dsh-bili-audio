/**
 * 客户端 bundle 的结构契约。
 *
 * DSH 的客户端 bundle 没有构建步骤：它必须是「执行时自己向
 * window.__ModuleLoader__.load 注册」的单文件。这个用例用假的 window / react
 * 把 bundle 跑一遍，确认 id、导出形状、以及 shell.overlay 的注册参数都对。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** 记录 bundle 注册进来的定义。 */
let definition

// bundle 顶层就会读 window.__ModuleLoader__，必须在 import 之前铺好
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

/** 极简 react 替身：只提供 factory 会解构的成员，不执行任何组件。 */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
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
    Fragment: Symbol('Fragment'),
  }
}

test('bundle 以约定的 id 注册', () => {
  assert.notEqual(definition, undefined, 'client.js 应该调用 window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-bili-audio')
  assert.equal(typeof definition.factory, 'function')
})

test('factory 只 require("react")，导出 name / inject / apply', () => {
  const required = []
  const clientModule = definition.factory((specifier) => {
    required.push(specifier)
    assert.equal(specifier, 'react')
    return fakeReact()
  })
  assert.deepEqual(required, ['react'])
  assert.equal(clientModule.name, 'dsh-bili-audio')
  assert.deepEqual(clientModule.inject, ['slots'])
  assert.equal(typeof clientModule.apply, 'function')
})

test('apply 在 shell.overlay 挂一个悬浮播放条', () => {
  const clientModule = definition.factory(() => fakeReact())
  const injected = []
  const registered = []
  const ctx = {
    slots: {
      inject(name, factory) {
        injected.push(name)
        return factory()
      },
      register(entry, component) {
        registered.push({ entry, component })
        return () => {}
      },
    },
  }
  // Node 里没有 document：ensureStyles 应该被 apply 内部的 try/catch 吞掉
  clientModule.apply(ctx)

  assert.deepEqual(injected, ['shell.overlay'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].entry.name, 'shell.overlay')
  assert.equal(registered[0].entry.id, 'dsh-bili-audio')
  assert.equal(registered[0].entry.order, 80)
  assert.equal(typeof registered[0].component, 'function')
})

test('bundle 里没有 import/export 语句（必须是自注册单文件）', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 顶层的 import/export 会让浏览器把它当模块加载，而 DSH 是按普通脚本注入的
  assert.equal(/^\s*import\s/m.test(source), false)
  assert.equal(/^\s*export\s/m.test(source), false)
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
})

/* ------------------------------------------------------------------ *
 * 渲染冒烟：没有真 DSH 可启动，就用一个极小的 hooks 运行时把组件跑一遍，
 * 至少保证「初始渲染 + 副作用」不会抛异常（错字、空引用、hooks 顺序问题）。
 * ------------------------------------------------------------------ */

/** 假 DOM 元素：只实现客户端代码真正会碰的那几个 DOM API。 */
function fakeElement(type, props, children) {
  const node = {
    type,
    props,
    children: children.filter((child) => child !== undefined && child !== null && child !== false),
    _attrs: {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null
    },
    removeAttribute(name) {
      delete this._attrs[name]
    },
    load() {},
    pause() {},
    play() {
      return Promise.resolve()
    },
  }
  Object.defineProperty(node, 'src', {
    get() {
      return this._attrs.src
    },
    set(value) {
      this._attrs.src = value
    },
  })
  node.volume = 1
  node.playbackRate = 1
  node.currentTime = 0
  node.paused = true
  node.duration = 0
  if (props !== null && typeof props === 'object') {
    if (props.ref !== null && typeof props.ref === 'object') props.ref.current = node
    if (props.src !== undefined) node._attrs.src = props.src
  }
  return node
}

/**
 * 最小 hooks 运行时。
 *
 * 每次 flush 按位置重放 hook 槽位（与 React 的 hooks 规则一致），所以 setState
 * 之后可以重新渲染整棵树、检查队列/播放条的真实状态。effect 的依赖数组不参与
 * 判断——测试里让它们每次渲染都跑一遍是安全的（client 的 effect 都幂等）。
 */
function createHookRuntime() {
  const slots = []
  let effects = []
  let cursor = 0
  let component = null
  let tree = null
  let dirty = true

  const react = {
    createElement(type, props, ...children) {
      return fakeElement(type, props, children)
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) {
        slots[index] = typeof initial === 'function' ? initial() : initial
      }
      const set = (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
        dirty = true
      }
      return [slots[index], set]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(fn) {
      effects.push(fn)
      cursor += 1
    },
    useCallback(fn) {
      cursor += 1
      return fn
    },
    useMemo(fn) {
      cursor += 1
      return fn()
    },
  }

  const runtime = {
    react,
    render(instance) {
      component = instance
      dirty = true
      runtime.flush()
      return tree
    },
    /** 把 setState 引起的变化渲染完（上限 50 次，防止测试挂死）。 */
    flush() {
      let guard = 0
      while (dirty && guard < 50) {
        dirty = false
        cursor = 0
        effects = []
        tree = component({})
        guard += 1
      }
      if (guard >= 50) throw new Error('渲染没有收敛（疑似 setState 死循环）')
      return tree
    },
    runEffects() {
      for (const fn of effects) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanup()
      }
    },
    get tree() {
      return tree
    },
  }

  return runtime
}

/** 在渲染树里找满足条件的节点。 */
function findNodes(node, predicate, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) findNodes(child, predicate, out)
  return out
}

function findByClass(tree, className) {
  return findNodes(tree, (node) => {
    const value = node.props && node.props.className
    return typeof value === 'string' && value.split(/\s+/).includes(className)
  })
}

function findButtonByText(tree, label) {
  return findNodes(tree, (node) => {
    if (node.type !== 'button') return false
    return collectText(node).join('').trim() === label
  })
}

/** 等异步解析（假 fetch 是微任务）落定，再把渲染追平。 */
async function settle(runtime) {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    runtime.flush()
  }
  runtime.runEffects()
}

/** 把渲染树里的文本节点收集出来，用于断言文案语言。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  for (const child of node.children ?? []) collectText(child, out)
  return out
}

/** 铺一个够用的全局 DOM / storage 环境。 */
function installFakeDom(lang, prefs) {
  // Node 24 自带只读的 navigator，直接赋值会抛，必须用 defineProperty 覆盖
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      documentElement: { lang },
      head: { append() {} },
      querySelector() {
        return null
      },
      createElement() {
        return { textContent: '', setAttribute() {} }
      },
    },
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { language: lang, clipboard: undefined },
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem() {
        return prefs ?? null
      },
      setItem() {},
    },
  })
  // 组件里用 window.localStorage 而不是裸 localStorage
  globalThis.window.localStorage = globalThis.localStorage
}

test('首帧渲染（中文，展开态）不抛异常，且包含输入框与队列空态', () => {
  installFakeDom('zh-CN', null)
  const runtime = createHookRuntime()
  const clientModule = definition.factory(() => runtime.react)
  let component
  clientModule.apply({
    slots: {
      inject(name, factory) {
        return factory()
      },
      register(entry, instance) {
        component = instance
        return () => {}
      },
    },
  })
  assert.equal(typeof component, 'function')

  const tree = runtime.render(component)
  runtime.runEffects()

  assert.equal(tree.type, 'div')
  assert.equal(tree.props['data-bili-audio'], 'expanded')
  // 第一个子节点必须是 <audio>：最小化/展开时靠它保持同一个 DOM 节点，播放才不会断
  assert.equal(tree.children[0].type, 'audio')
  const text = collectText(tree).join(' ')
  assert.match(text, /B站音频/)
  assert.match(text, /解析并播放/)
  assert.match(text, /队列是空的/)
})

test('首帧渲染（英文）跟随 <html lang>', () => {
  installFakeDom('en-US', null)
  const runtime = createHookRuntime()
  const clientModule = definition.factory(() => runtime.react)
  let component
  clientModule.apply({
    slots: {
      inject(name, factory) {
        return factory()
      },
      register(entry, instance) {
        component = instance
        return () => {}
      },
    },
  })
  const tree = runtime.render(component)
  runtime.runEffects()
  const text = collectText(tree).join(' ')
  assert.match(text, /Bilibili Audio/)
  assert.match(text, /Resolve & play/)
  assert.match(text, /Queue is empty/)
})

test('偏好里的 open:false 会渲染成最小化的圆形入口', () => {
  installFakeDom('zh-CN', JSON.stringify({ open: false }))
  const runtime = createHookRuntime()
  const clientModule = definition.factory(() => runtime.react)
  let component
  clientModule.apply({
    slots: {
      inject(name, factory) {
        return factory()
      },
      register(entry, instance) {
        component = instance
        return () => {}
      },
    },
  })
  const tree = runtime.render(component)
  runtime.runEffects()
  assert.equal(tree.props['data-bili-audio'], 'minimized')
  assert.equal(tree.children[0].type, 'audio')
  assert.equal(tree.children[1].type, 'button')
  assert.equal(tree.children[1].props.className, 'ba-pill')
})

test('队列交互：解析并播放 → 只入队 → 切歌 → 清空', async () => {
  installFakeDom('zh-CN', null)

  // 假 fetch：只负责 /resolve，按链接里是否含 BV1aaaaaaaaa 返回两首不同的歌
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (requestUrl) => {
    const parsed = new URL(String(requestUrl), 'http://127.0.0.1')
    const link = parsed.searchParams.get('url') || ''
    const second = link.includes('BV1aaaaaaaaa')
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          title: second ? '第二首' : '第一首',
          bvid: link,
          cid: '137649199',
          duration: 213,
          audioUrl:
            'https://a.bilivideo.com/' + (second ? 'second' : 'first') + '.m4s',
          backups: [],
        }
      },
    }
  }

  try {
    const runtime = createHookRuntime()
    const clientModule = definition.factory(() => runtime.react)
    let component
    clientModule.apply({
      slots: {
        inject(name, factory) {
          return factory()
        },
        register(entry, instance) {
          component = instance
          return () => {}
        },
      },
    })
    runtime.render(component)
    runtime.runEffects()

    // 1) 输入 BV 号 → 点「解析并播放」
    findByClass(runtime.tree, 'ba-input')[0].props.onChange({
      target: { value: 'BV1GJ411x7h7' },
    })
    runtime.flush()
    const playButton = findButtonByText(runtime.tree, '解析并播放')[0]
    assert.notEqual(playButton, undefined, '应该能找到「解析并播放」按钮')
    playButton.props.onClick()
    await settle(runtime)

    assert.equal(findByClass(runtime.tree, 'ba-item').length, 1, '队列里应该有一条')
    assert.match(collectText(runtime.tree).join(' '), /第一首/)

    // <audio> 的 src 必须指向宿主的 stream 代理，而不是 CDN 原地址
    const audio = runtime.tree.children[0]
    assert.equal(audio.type, 'audio')
    const src = String(audio.getAttribute('src') || '')
    assert.match(src, /^\/bili-audio\/api\/stream\?u=/)
    assert.equal(src.includes('a.bilivideo.com'), true, 'src 应该带着被 encode 的 CDN 地址')

    // 2) 第二条「只入队」：队列变 2 条，但不抢占当前播放
    findByClass(runtime.tree, 'ba-input')[0].props.onChange({
      target: { value: 'BV1aaaaaaaaa' },
    })
    runtime.flush()
    const addOnly = findButtonByText(runtime.tree, '只入队')[0]
    assert.notEqual(addOnly, undefined, '应该能找到「只入队」按钮')
    addOnly.props.onClick()
    await settle(runtime)

    assert.equal(findByClass(runtime.tree, 'ba-item').length, 2, '两条都在队列里')
    const nowTitle = findByClass(runtime.tree, 'ba-now-title')[0]
    assert.equal(collectText(nowTitle).join(''), '第一首', '只入队不应该切走当前曲目')

    // 3) 点第二条切歌
    const rows = findByClass(runtime.tree, 'ba-item')
    rows[1].props.onClick()
    await settle(runtime)
    assert.equal(
      collectText(findByClass(runtime.tree, 'ba-now-title')[0]).join(''),
      '第二首',
      '点队列行应该切歌',
    )
    assert.match(
      String(runtime.tree.children[0].getAttribute('src') || ''),
      /second\.m4s/,
      '切歌后 audio.src 应该换成第二首的代理地址',
    )

    // 4) 清空
    findButtonByText(runtime.tree, '清空')[0].props.onClick()
    runtime.flush()
    assert.equal(findByClass(runtime.tree, 'ba-item').length, 0, '清空后队列应该为空')
    assert.match(collectText(runtime.tree).join(' '), /队列是空的/)
  } finally {
    globalThis.fetch = previousFetch
  }
})