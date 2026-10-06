// /cycles: ride a light cycle in an online lobby every player shares, in an
// arena sized to the lobby. The lobby is server/server.ts in this plugin's repo.
// The desktop app draws the board as an Svg, the terminal as a Raster, and
// W A S D buttons steer on both. The mod reaches nothing but the lobby's URL
// and its own store, where it keeps your rider name and the lobby you last joined.
import type { Elements, EngineInterface, Register, Timer } from 'claude-code'

import { decodeCells, PROTOCOL } from './protocol'
import type { Dir, Frame } from './protocol'

const PANE = 'lightcycles'
// The public lobby. To run your own, deploy server/ and point this at it, or
// join any lobby with /cycles join <url>
const PUBLIC_LOBBY = 'https://lightcycles.onrender.com'
// The desktop app redraws a pane at most 10 times a second
const POLL_MS = 100
const OFFLINE_RETRY_MS = 2000
const MISMATCH_RETRY_MS = 60_000

const BACKDROP = '#04070c'
const GRID_LINE = '#123552'
const HEAD = '#f8fafc'
const ALERT = '#f87171'
const SCORE_LABEL = '#6b8aa6'
const WALL = '#38bdf8'
const OUTSIDE = '#1c0a12'
const GRID_SPACING = 8
const GLOW =
  '<filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.5" result="blur"/>' +
  '<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
// An Svg holds at most 131,072 characters; trails past this budget, farthest first, are left out
const SVG_BUDGET = 120_000
const STEERING: { key: string; label: string; hotkey: string; dir: Dir }[] = [
  { key: 'left', label: '←', hotkey: 'a', dir: 3 },
  { key: 'up', label: '↑', hotkey: 'w', dir: 0 },
  { key: 'down', label: '↓', hotkey: 's', dir: 2 },
  { key: 'right', label: '→', hotkey: 'd', dir: 1 },
]
const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗']

let lobby = PUBLIC_LOBBY
let name = 'rider'
let riderId: string | null = null
let frame: Frame | null = null
let status = 'Connecting…'
let retryAt = 0
let poller: Timer | null = null
let isPolling = false
let hasLoaded = false
// The board's size in cells, as the pane last drew it; each poll asks the lobby for this much
let view = { w: 60, h: 80 }

type Controls = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>

const mod = (n: number, m: number) => ((n % m) + m) % m
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const escapeXml = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

// A lobby that answered with something other than what this version of the mod speaks
class LobbyMismatch extends Error {}

async function call($: EngineInterface, method: 'GET' | 'POST', path: string, body?: object) {
  const response = await $.http.fetch(
    `${lobby}${path}`,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  )

  return { code: response.status, data: response.text ? JSON.parse(response.text) : null }
}

async function join($: EngineInterface) {
  const { code, data } = await call($, 'POST', '/join', { name })
  if (code === 503) throw new LobbyMismatch(`The lobby at ${lobby} is full. Trying again in a minute.`)
  if (code !== 200) throw new Error(`The lobby answered ${code} to a join`)
  if (data.protocol !== PROTOCOL) {
    throw new LobbyMismatch(`The lobby at ${lobby} runs a different version of lightcycles. Update the plugin in /plugin.`)
  }
  riderId = data.id
  frame = null
}

async function leave($: EngineInterface) {
  if (riderId !== null) await call($, 'POST', '/leave', { id: riderId }).catch(() => undefined)
  riderId = null
  frame = null
}

async function steer($: EngineInterface, dir: Dir) {
  if (riderId !== null) await call($, 'POST', '/turn', { id: riderId, turns: [dir] }).catch(() => undefined)
}

async function fetchView($: EngineInterface) {
  if ((await $.clock.now()) < retryAt) return
  try {
    if (riderId === null) await join($)
    const { code, data } = await call($, 'GET', `/view?id=${riderId}&w=${view.w}&h=${view.h}`)
    // The lobby restarted and forgot us: join again on the next poll
    if (code === 404) riderId = null
    else {
      frame = { ...data, cells: decodeCells(data.cells) }
      status = ''
    }
  } catch (error) {
    riderId = null
    frame = null
    const isMismatch = error instanceof LobbyMismatch
    status = isMismatch ? error.message : `No lobby answers at ${lobby} yet. Still trying…`
    retryAt = (await $.clock.now()) + (isMismatch ? MISMATCH_RETRY_MS : OFFLINE_RETRY_MS)
  }
}

// One view request at a time; a tick that lands while one is out skips
async function poll($: EngineInterface) {
  if (isPolling) return
  isPolling = true
  try {
    await fetchView($)
    $.ui.invalidate('ui.render')
  } finally {
    isPolling = false
  }
}

function startPolling($: EngineInterface) {
  poller ??= $.clock.every(POLL_MS, () => void poll($))
}

function stopPolling() {
  poller?.cancel()
  poller = null
}

// Your name and the lobby you last joined, kept for next time; read once, on the first /cycles
async function loadSaved($: EngineInterface) {
  if (hasLoaded) return
  hasLoaded = true
  const savedName = await $.store.get('name')
  const savedLobby = await $.store.get('lobby')
  if (typeof savedName === 'string') name = savedName
  if (typeof savedLobby === 'string') lobby = savedLobby
}

async function ride($: EngineInterface, args: string) {
  await loadSaved($)
  const [first, ...rest] = args.trim().split(/\s+/).filter(Boolean)

  if (first === 'leave') {
    stopPolling()
    await leave($)
    status = 'You left the lobby. Type /cycles to ride again.'
    await $.ui.close({ id: PANE })
    return 'Left the light-cycle lobby.'
  }

  const nextLobby = first === 'join' ? (rest[0] ?? PUBLIC_LOBBY).replace(/\/+$/, '') : lobby
  if (!/^https?:\/\/[^\s/]+/.test(nextLobby)) return `${nextLobby} isn't a lobby URL. Try /cycles join https://host.example.`
  const nextName = (first === 'join' ? rest[1] : first) ?? name
  if (nextLobby !== lobby || nextName !== name) await leave($)
  lobby = nextLobby
  name = nextName
  await $.store.set('name', name)
  await $.store.set('lobby', lobby)

  status = 'Connecting… a lobby on free hosting can take a minute to wake up.'
  retryAt = 0
  startPolling($)
  await $.ui.open({ id: PANE, title: 'Light cycles', focus: true })

  return `Riding as ${name} at ${lobby}. Steer with W A S D; click the pane first if the keys go to the prompt.`
}

// The desktop board's size in cells: a wider pane sees more of the map, and the
// board keeps between 3:5 and 8:5 so it fits the window
function desktopView(bodyColumns: number, windowRows: number | undefined) {
  const w = clamp(Math.round(bodyColumns * 1.4), 40, 120)
  // A code-font cell is about 0.4 as wide as it is tall
  const aspect = windowRows === undefined ? 0.75 : clamp((bodyColumns * 0.4) / Math.max(10, windowRows - 8), 0.6, 1.6)

  return { w, h: Math.round(w / aspect) }
}

// A dot at the board's edge toward the nearest rider, when they're off screen
function nearestMarker(frame: Frame) {
  const { nearest } = frame
  const cx = Math.floor(frame.w / 2)
  const cy = Math.floor(frame.h / 2)
  if (nearest === null || (Math.abs(nearest.dx) < cx && Math.abs(nearest.dy) < cy)) return ''
  const reach = Math.max(Math.abs(nearest.dx) / (cx - 2), Math.abs(nearest.dy) / (cy - 2))
  const x = cx + nearest.dx / reach
  const y = cy + nearest.dy / reach

  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.2" fill="${frame.colors[nearest.color]}"/>`
}

function boardSvg(frame: Frame) {
  const { w, h, you, colors } = frame
  const cx = Math.floor(w / 2)
  const cy = Math.floor(h / 2)

  // Each horizontal run of one color is one path segment; heads are drawn on top in white
  const runs: { segment: string; color: string; distance: number }[] = []
  const heads: string[] = []
  for (let y = 0; y < h; y++) {
    let x = 0
    while (x < w) {
      const code = frame.cells.charCodeAt(y * w + x)
      if (code === 46) {
        x += 1
        continue
      }
      if (code >= 97) {
        heads.push(`<rect x="${x - 0.15}" y="${y - 0.15}" width="1.3" height="1.3" fill="${HEAD}"/>`)
        x += 1
        continue
      }
      let end = x + 1
      while (end < w && frame.cells.charCodeAt(y * w + end) === code) end += 1
      const length = end - x
      runs.push({
        segment: `M${x} ${y}h${length}v1h-${length}z`,
        color: colors[code - 65] ?? HEAD,
        distance: Math.abs(y - cy) + Math.abs(x + length / 2 - cx),
      })
      x = end
    }
  }
  runs.sort((a, b) => a.distance - b.distance)
  const segments = new Map<string, string[]>()
  let budget = SVG_BUDGET - heads.join('').length
  for (const run of runs) {
    budget -= run.segment.length
    if (budget < 0) break
    segments.set(run.color, [...(segments.get(run.color) ?? []), run.segment])
  }
  const trails = [...segments].map(([color, parts]) => `<path fill="${color}" d="${parts.join('')}"/>`).join('')

  const ring = you.isAlive
    ? `<rect x="${cx - 1.5}" y="${cy - 1.5}" width="4" height="4" rx="1" fill="none" stroke="${colors[you.color]}" stroke-width="0.25"/>`
    : ''
  const font = 'font-family="ui-monospace, Menlo, monospace" text-anchor="middle"'
  const derezzed = you.isAlive
    ? ''
    : `<rect y="${cy - w / 8}" width="${w}" height="${w / 4}" fill="${BACKDROP}" opacity="0.8"/>` +
      `<text x="${cx}" y="${cy}" ${font} font-weight="700" font-size="${w / 9}" fill="${ALERT}">DEREZZED</text>` +
      `<text x="${cx}" y="${cy + w / 14}" ${font} font-size="${w / 28}" fill="${HEAD}">` +
      `${escapeXml(`by ${you.derezzedBy ?? 'the grid'} · back in ${(you.respawnMs / 1000).toFixed(1)}s`)}</text>`
  // The grid is fixed to the world, so it slides past as you ride
  const gx = mod(-frame.x0, GRID_SPACING)
  const gy = mod(-frame.y0, GRID_SPACING)
  // Outside the walls is shaded; the wall glows cyan, or red while it closes in
  const { half, isShrinking } = frame.arena
  const ix = -half + 1 - frame.x0
  const iy = -half + 1 - frame.y0
  const side = 2 * half - 1
  const outside = `<path fill="${OUTSIDE}" fill-rule="evenodd" d="M0 0h${w}v${h}h-${w}zM${ix} ${iy}h${side}v${side}h-${side}z"/>`
  const wall = `<rect x="${ix}" y="${iy}" width="${side}" height="${side}" fill="none" stroke="${isShrinking ? ALERT : WALL}" stroke-width="0.5" filter="url(#glow)"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 10}" height="${h * 10}">` +
    `<defs><pattern id="grid" width="${GRID_SPACING}" height="${GRID_SPACING}" patternUnits="userSpaceOnUse" patternTransform="translate(${gx} ${gy})">` +
    `<path d="M${GRID_SPACING} 0H0V${GRID_SPACING}" fill="none" stroke="${GRID_LINE}" stroke-width="0.15"/></pattern>` +
    `${GLOW}</defs>` +
    `<rect width="${w}" height="${h}" fill="${BACKDROP}"/><rect width="${w}" height="${h}" fill="url(#grid)"/>${outside}${wall}` +
    `<g filter="url(#glow)" shape-rendering="crispEdges">${trails}${heads.join('')}</g>` +
    `${ring}${nearestMarker(frame)}${derezzed}</svg>`
  )
}

// The desktop's score, best and kills counters: three big tiles, as wide as the board
function scoreSvg(frame: Frame, w: number) {
  const { you, colors } = frame
  const stats = [
    { label: 'SCORE', value: you.run, color: colors[you.color] ?? HEAD },
    { label: 'BEST', value: you.best, color: HEAD },
    { label: 'KILLS', value: you.kills, color: ALERT },
  ]
  const tile = w / stats.length
  const font = 'font-family="ui-monospace, Menlo, monospace" text-anchor="middle"'
  const tiles = stats.map(({ label, value, color }, index) => {
    const x = index * tile
    // Shrinks for long numbers so five digits still fit a tile
    const size = Math.min(7, (tile - 3) / (0.62 * Math.max(3, String(value).length)))
    return (
      `<rect x="${x + 0.5}" y="0.5" width="${tile - 1}" height="13" rx="1.2" fill="#0a1420" stroke="${color}" stroke-width="0.2" stroke-opacity="0.6"/>` +
      `<text x="${x + tile / 2}" y="8.6" ${font} font-size="${size.toFixed(2)}" font-weight="700" fill="${color}" filter="url(#glow)">${value}</text>` +
      `<text x="${x + tile / 2}" y="11.8" ${font} font-size="2.2" letter-spacing="0.4" fill="${SCORE_LABEL}">${label}</text>`
    )
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 14" width="${w * 10}" height="140">` +
    `<defs>${GLOW}</defs>${tiles.join('')}</svg>`
  )
}

// A pixel's color: a trail, a head, the shade outside the walls, or null for open grid
function pixel(frame: Frame, x: number, y: number) {
  if (x >= 0 && y >= 0 && x < frame.w && y < frame.h) {
    const code = frame.cells.charCodeAt(y * frame.w + x)
    if (code >= 97) return HEAD
    if (code >= 65) return frame.colors[code - 65] ?? HEAD
  }
  const { half } = frame.arena

  return Math.abs(frame.x0 + x) < half && Math.abs(frame.y0 + y) < half ? null : OUTSIDE
}

// The terminal board: each cell is '▀' in the top pixel's color over the bottom pixel's
function boardCells(frame: Frame, columns: number, rows: number) {
  const hex = (color: string) => parseInt(color.slice(1), 16)
  // The frame may be sized for the last layout; keep your rider centered either way
  const ox = Math.floor((frame.w - columns) / 2)
  const oy = Math.floor((frame.h - rows * 2) / 2)
  const words: number[] = []
  for (let row = 0; row < rows; row++) {
    for (let x = 0; x < columns; x++) {
      const top = pixel(frame, x + ox, row * 2 + oy)
      const bottom = pixel(frame, x + ox, row * 2 + 1 + oy)
      if (top !== null || bottom !== null) {
        words.push(0x2580, hex(top ?? BACKDROP), hex(bottom ?? BACKDROP))
        continue
      }
      const wy = frame.y0 + row * 2 + oy
      const isDot = mod(frame.x0 + x + ox, GRID_SPACING) === 0 && (mod(wy, GRID_SPACING) === 0 || mod(wy + 1, GRID_SPACING) === 0)
      words.push(isDot ? 0xb7 : 0x20, hex(GRID_LINE), hex(BACKDROP))
    }
  }

  return new Uint8Array(Uint32Array.from(words).buffer).toBase64()
}

// Your name, the rider count and the nearest rider; the terminal adds the counters, which the desktop draws big
function hud({ Box, Text }: Controls, frame: Frame, hasCounters: boolean) {
  const { you, nearest, colors } = frame
  const parts = [<Text bold color={colors[you.color]}>{you.name}</Text>]
  if (hasCounters) {
    parts.push(
      <Text bold color={colors[you.color]}>{`SCORE ${you.run}`}</Text>,
      <Text bold>{`BEST ${you.best}`}</Text>,
      <Text bold color={ALERT}>{`KILLS ${you.kills}`}</Text>,
    )
  }
  parts.push(<Text dimColor>{`${frame.riders} riders · arena ${2 * frame.arena.half - 1}²`}</Text>)
  if (frame.arena.isShrinking) parts.push(<Text bold color={ALERT}>WALL CLOSING</Text>)
  if (nearest !== null) {
    const distance = Math.round(Math.hypot(nearest.dx, nearest.dy))
    const arrow = ARROWS[mod(Math.round(Math.atan2(nearest.dy, nearest.dx) / (Math.PI / 4)), 8)]
    parts.push(<Text color={colors[nearest.color]}>{`${nearest.name} ${arrow} ${distance}`}</Text>)
  }

  return (
    <Box key="hud" flexDirection="row" flexWrap="wrap" columnGap={2}>
      {parts}
    </Box>
  )
}

function controls({ Box, Text, Button }: Controls, $: EngineInterface, frame: Frame | null) {
  const standings = (frame?.standings ?? []).map((standing, index) => (
    <Text color={frame!.colors[standing.color]} bold={standing.isYou}>{`${index + 1} ${standing.name} ${standing.best}`}</Text>
  ))

  return (
    <Box key="controls" flexDirection="column" gap={1}>
      <Box flexDirection="row" columnGap={1}>
        {STEERING.map(control => (
          <Button key={control.key} label={control.label} hotkey={control.hotkey} plain onPress={() => steer($, control.dir)} />
        ))}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {standings}
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cycles',
      description: 'Ride a light cycle in the online lobby: /cycles [name], /cycles join <url> [name], /cycles leave',
    })
    // After a reload, keep an open board moving
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) startPolling($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopPolling()
    await leave($)

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      stopPolling()
      await leave($)
    }

    return next(e)
  })

  on('command.run', { command: 'cycles' }, async ($, e) => ({ text: await ride($, e.args ?? '') }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'desktop') {
      const { Box, Text, Button, Svg } = $.ui.resolve(e)
      view = desktopView(e.props.bodyColumns, e.viewport?.rows)
      if (frame === null) {
        return (
          <Box flexDirection="column" gap={1}>
            <Text bold color="#22d3ee">LIGHT CYCLES</Text>
            <Text>{status}</Text>
            {controls({ Box, Text, Button }, $, frame)}
          </Box>
        )
      }
      const { you } = frame

      return (
        <Box flexDirection="column" gap={1}>
          {hud({ Box, Text, Button }, frame, false)}
          <Svg key="score" source={scoreSvg(frame, view.w)} alt={`Score ${you.run}, best ${you.best}, kills ${you.kills}`} />
          <Svg key="board" source={boardSvg(frame)} alt={`Light-cycle board: ${frame.riders} riders`} />
          {controls({ Box, Text, Button }, $, frame)}
        </Box>
      )
    }

    if (e.surface === 'terminal') {
      const { Box, Text, Button, Raster } = $.ui.resolve(e)
      const columns = clamp(e.props.bodyColumns, 1, 512)
      const rows = clamp(e.props.placement === 'dock' ? e.props.scroll.bodyRows - 4 : 20, 4, 256)
      view = { w: columns, h: rows * 2 }
      const board =
        frame === null ? (
          <Text>{status}</Text>
        ) : (
          <Raster key="board" columns={columns} rows={rows} cells={boardCells(frame, columns, rows)} />
        )

      return (
        <Box flexDirection="column">
          {frame === null ? <Text bold color="#22d3ee">LIGHT CYCLES</Text> : hud({ Box, Text, Button }, frame, true)}
          {board}
          {controls({ Box, Text, Button }, $, frame)}
        </Box>
      )
    }

    const { Text } = $.ui.resolve(e)
    return <Text>Light cycles draws in the terminal and the desktop app.</Text>
  })
}
