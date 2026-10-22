/**
 * 清单与工程文件的契约。
 *
 * 这一组用例守的是「能上架」：package.json 的字段、cordis.patch.yml 的挂载行、
 * 版本号一致性、LICENSE/README 是否存在，以及客户端与宿主的路由前缀有没有跑偏。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import * as host from '../lib/index.js'

const packageUrl = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(await readFile(packageUrl, 'utf8'))

const read = (name) => readFile(new URL('../' + name, import.meta.url), 'utf8')

test('package.json 基本字段', () => {
  assert.equal(pkg.name, 'dsh-bili-audio')
  assert.equal(pkg.version, '0.1.0')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.description.length > 20, true)
})

test('exports 暴露宿主入口、客户端入口与 package.json', () => {
  assert.equal(pkg.exports['.'].default, './lib/index.js')
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.equal(pkg.exports['./package.json'], './package.json')
})

test('files 覆盖运行时需要的全部文件（publish 后不缺东西）', () => {
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(entry), 'files 里缺少 ' + entry)
  }
})

test('dsh 清单：bundle patch + web 客户端注入', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-slots'])
})

test('keywords 含 dsh-plugin / dsh / bilibili', () => {
  for (const keyword of ['dsh-plugin', 'dsh', 'bilibili']) {
    assert.ok(pkg.keywords.includes(keyword), 'keywords 里缺少 ' + keyword)
  }
})

test('engines 声明 DSH 版本下限', () => {
  assert.equal(typeof pkg.engines.dsh, 'string')
  assert.match(pkg.engines.dsh, /^>=\d+\.\d+\.\d+/)
})

test('package.json 的 version 与宿主导出的 VERSION 一致', () => {
  assert.equal(host.VERSION, pkg.version)
})

test('宿主导出 name / inject / apply', () => {
  assert.equal(host.name, 'bili-audio')
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
})

test('cordis.patch.yml 插入的行与插件名一致', async () => {
  const yaml = await read('cordis.patch.yml')
  assert.match(yaml, /insert:/)
  assert.match(yaml, /id:\s*bili-audio/)
  assert.match(yaml, /name:\s*['"]?dsh-bili-audio['"]?/)
})

test('客户端与宿主使用同一个路由前缀', async () => {
  const client = await read('lib/client.js')
  assert.ok(client.includes("'/bili-audio/api'"), '客户端应该用 /bili-audio/api 前缀')
  assert.ok(client.includes('/resolve?url='), '客户端要调用 resolve')
  assert.ok(client.includes('/stream?u='), '客户端要调用 stream')
  assert.equal(host.__internals.API, '/bili-audio/api')
})

test('LICENSE 是 MIT 且带占位版权行', async () => {
  const license = await read('LICENSE')
  assert.match(license, /MIT License/)
  assert.match(license, /Copyright \(c\) 2026/)
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/)
})
