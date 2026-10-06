import type { HttpResponse, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { decodeCells, encodeCells, PROTOCOL } from '../hooks/protocol'

type Engine = Parameters<Parameters<typeof test>[1]>[0]
type Arena = { half: number; isShrinking: boolean }

const paneProps = (columns: number, rows: number) => ({
  title: 'Light cycles',
  isFocused: true,
  bodyColumns: columns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: rows },
  view: {},
})

const reply = (data: unknown, status = 200): { value: HttpResponse } => ({
  value: { status, ok: status === 200, headers: {}, text: JSON.stringify(data) },
})

// One rider with a short trail, heading up from the middle of the view
const shortTrail = (x: number, y: number, w: number, h: number) =>
  x === Math.floor(w / 2) && y === Math.floor(h / 2) ? 'a' : x === Math.floor(w / 2) && y === Math.floor(h / 2) + 1 ? 'A' : '.'

// A lobby in memory: records what the mod sends, and answers views drawn by `paint`
// in `arena`, run-length encoded as the real server sends them
function fakeLobby(on: On, { paint = shortTrail, arena = { half: 200, isShrinking: false } as Arena, protocol = PROTOCOL } = {}) {
  const sent: { method: string; url: string; path: string; body: unknown }[] = []
  on('http.fetch', async ($, e) => {
    const [path, search = ''] = e.url.replace(/^https?:\/\/[^/]+/, '').split('?')
    const query = Object.fromEntries(search.split('&').map(pair => pair.split('=')))
    sent.push({ method: e.init?.method ?? 'GET', url: e.url, path, body: e.init?.body ? JSON.parse(e.init.body) : null })
    if (path === '/join') return reply({ id: 'rider-1', color: 0, protocol })
    if (path !== '/view') return reply({ ok: true })
    const w = Number(query.w)
    const h = Number(query.h)
    const cells: string[] = []
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push(paint(x, y, w, h))
    return reply({
      tick: 1,
      x0: -Math.floor(w / 2),
      y0: -Math.floor(h / 2),
      w,
      h,
      cells: encodeCells(cells.join('')),
      colors: ['#22d3ee', '#fb923c', '#e879f9', '#a3e635'],
      arena,
      you: { name: 'Tester', color: 0, isAlive: true, run: 3, best: 9, kills: 1, derezzedBy: null, respawnMs: 0 },
      riders: 2,
      standings: [{ name: 'Tester', color: 0, best: 9, kills: 1, isYou: true }],
      nearest: { name: 'byte', color: 1, dx: 50, dy: -50 },
    })
  })

  return sent
}

// The source of the Svg whose alt text starts with `alt`
async function svgSource(ui: { findAll: (query: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }, alt: string) {
  const found = (await ui.findAll({ type: 'Svg' })).find(svg => String(svg.props.alt).startsWith(alt))
  return found?.props.source as string
}

// Runs /cycles against the fake lobby, mounts its pane on `surface`, and lets one poll land
async function ride($: Engine, on: On, surface: 'terminal' | 'desktop', lobby: Parameters<typeof fakeLobby>[1] = {}, args = 'Tester') {
  const clock = mock.clock(on)
  mock.store(on)
  const sent = fakeLobby(on, lobby)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const { text } = await $.command.run({ command: 'cycles', args })
  const ui = await $.ui.mount({
    plugin: 'lightcycles',
    surface,
    component: 'Pane',
    requestId: 'lightcycles',
    props: paneProps(43, 40),
    viewport: { columns: 120, rows: 46 },
  })
  await clock.advance(100)
  await ui.redraw()

  return { text, ui, sent, clock }
}

test('cells survive run-length encoding', () => {
  const cells = `${'.'.repeat(40)}AAAb${'.'.repeat(12)}C${'L'.repeat(101)}..`
  expect(encodeCells(cells)).toBe('.40A3b.12CL101.2')
  expect(decodeCells(encodeCells(cells))).toBe(cells)
})

test('/cycles joins the public lobby and opens the pane', async ($, on) => {
  const { text, sent } = await ride($, on, 'desktop')
  expect(text).toContain('Riding as Tester at https://lightcycles.onrender.com')
  const joined = sent.find(request => request.path === '/join')
  expect(joined?.url).toBe('https://lightcycles.onrender.com/join')
  expect(joined?.body).toEqual({ name: 'Tester' })
})

test('/cycles join <url> rides in another lobby, and a bad URL is refused', async ($, on) => {
  const { sent } = await ride($, on, 'desktop', {}, 'join http://127.0.0.1:7777 Local')
  expect(sent.find(request => request.path === '/join')?.url).toBe('http://127.0.0.1:7777/join')
  const { text } = await $.command.run({ command: 'cycles', args: 'join not-a-url' })
  expect(text).toContain("isn't a lobby URL")
})

test('the desktop board is an Svg of the trails, with an edge marker toward the nearest rider', async ($, on) => {
  const { ui } = await ride($, on, 'desktop')
  const svg = await svgSource(ui, 'Light-cycle board')
  expect(svg).toContain('<path fill="#22d3ee"')
  expect(svg).toContain('<circle')
  expect(svg).toContain('fill="#fb923c"')
  expect(await ui.find({ text: /byte ↗ 71/ })).toBeDefined()
})

test('the desktop draws score, best and kills as big tiles', async ($, on) => {
  const { ui } = await ride($, on, 'desktop')
  const score = await svgSource(ui, 'Score')
  for (const tile of ['>3</text>', '>SCORE<', '>9</text>', '>BEST<', '>1</text>', '>KILLS<']) expect(score).toContain(tile)
})

test('the arena walls draw, and turn red with a warning while they close in', async ($, on) => {
  const { ui } = await ride($, on, 'desktop', { arena: { half: 10, isShrinking: true } })
  const svg = await svgSource(ui, 'Light-cycle board')
  expect(svg).toContain('fill-rule="evenodd"')
  expect(svg).toContain('stroke="#f87171"')
  expect(await ui.find({ text: /arena 19²/ })).toBeDefined()
  expect(await ui.find({ text: 'WALL CLOSING' })).toBeDefined()
})

test('W A S D buttons steer', async ($, on) => {
  const { ui, sent } = await ride($, on, 'desktop')
  const mark = sent.length
  await ui.press({ key: 'up' })
  await ui.press({ key: 'left' })
  const turns = sent.slice(mark).filter(request => request.path === '/turn')
  expect(turns.map(request => (request.body as { turns: number[] }).turns[0])).toEqual([0, 3])
})

test('the terminal board is a Raster that fills the docked pane', async ($, on) => {
  const { ui } = await ride($, on, 'terminal')
  const raster = await ui.find({ type: 'Raster' })
  expect(raster?.props.columns).toBe(43)
  expect(raster?.props.rows).toBe(36)
  expect(await ui.find({ text: 'SCORE 3' })).toBeDefined()
  expect(await ui.find({ text: 'KILLS 1' })).toBeDefined()
})

test('a crowded lobby keeps the Svg under its size limit', async ($, on) => {
  // Every other cell a trail, in four colors: far busier than play gets
  const { ui } = await ride($, on, 'desktop', { paint: (x, y) => ((x + y) % 2 === 0 ? 'ABCD'[(x + y) % 4] : '.') })
  const svg = await svgSource(ui, 'Light-cycle board')
  expect(svg.length).toBeLessThan(131_072)
})

test('a lobby on another protocol asks for an update', async ($, on) => {
  const { ui } = await ride($, on, 'desktop', { protocol: PROTOCOL + 1 })
  expect(await ui.find({ text: /runs a different version of lightcycles/ })).toBeDefined()
})

test('an unreachable lobby says it is still trying', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('http.fetch', () => ({ deny: 'connection refused' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({ command: 'cycles', args: 'Tester' })
  const ui = await $.ui.mount({
    plugin: 'lightcycles',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'lightcycles',
    props: paneProps(43, 40),
    viewport: { columns: 120, rows: 46 },
  })
  await clock.advance(100)
  await ui.redraw()
  expect(await ui.find({ text: /No lobby answers at https:\/\/lightcycles\.onrender\.com yet/ })).toBeDefined()
})

test('your name and lobby are kept for next time', async ($, on) => {
  mock.clock(on)
  mock.store(on, { name: 'Saved', lobby: 'http://127.0.0.1:7777' })
  fakeLobby(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  expect((await $.command.run({ command: 'cycles' })).text).toContain('Riding as Saved at http://127.0.0.1:7777')
  await $.command.run({ command: 'cycles', args: 'leave' })
  expect((await $.command.run({ command: 'cycles', args: 'Dylan' })).text).toContain('Riding as Dylan')
  expect((await $.command.run({ command: 'cycles' })).text).toContain('Riding as Dylan')
})
