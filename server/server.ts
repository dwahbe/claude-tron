// Lobby server for the lightcycles mod: one walled arena every rider shares,
// sized to the lobby. Each rider brings about the same room, so the arena's
// side grows with the square root of the rider count. It grows at once when
// riders join; when they leave it waits, then closes in a cell at a time,
// slower than anyone rides, and the closing wall derezzes whoever it catches.
//
//   bun server/server.ts [--port 7777] [--host 127.0.0.1] [--bots 4] [--tick 100]
//
// Plain HTTP: a host such as Render puts HTTPS in front of it. A PORT variable
// in the environment wins over --port, as hosts set one.
import { parseArgs } from 'node:util'

import { encodeCells, PROTOCOL } from '../plugins/lightcycles/hooks/protocol'
import type { Dir, Frame } from '../plugins/lightcycles/hooks/protocol'

const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string', default: '7777' },
    host: { type: 'string', default: '127.0.0.1' },
    bots: { type: 'string', default: '4' },
    // The desktop app redraws a pane at most 10 times a second, so a faster tick only skips frames
    tick: { type: 'string', default: '100' },
  },
})

const TICK_MS = Number(flags.tick)
const RESPAWN_MS = 1500
const IDLE_MS = 10_000
const MAX_VIEW = { w: 240, h: 160 }
// Open to anyone, so: a cap on human riders, a few joins a minute from one address,
// and small request bodies
const MAX_HUMANS = 40
const JOINS_PER_MINUTE = 6
const MAX_BODY_BYTES = 4096
const BOT_RANGE = 30
// Cells of arena per rider, about 55 by 55
const AREA_PER_RIDER = 3000
// Half the arena's side, in cells: the arena runs from -half to half, walls on the edges
const MIN_HALF = 40
const MAX_HALF = 500
// A shrink waits this long after the lobby gets smaller, so a rider who drops and rejoins moves nothing
const SHRINK_DELAY_MS = 5000
// Ticks per cell the wall closes in: 2.5 cells a second, against a rider's 10
const SHRINK_EVERY = 4
const SPAWN_MARGIN = 8
const COLORS = [
  '#22d3ee', '#fb923c', '#e879f9', '#a3e635', '#facc15', '#f87171',
  '#60a5fa', '#34d399', '#f472b6', '#a78bfa', '#fbbf24', '#e5e7eb',
]
const BOT_NAMES = ['byte', 'glitch', 'vector', 'pixel', 'nibble', 'kernel', 'daemon', 'cache']
const DX = [0, 1, 0, -1]
const DY = [-1, 0, 1, 0]

// A cell packs into one number, about a million cells each way
const OFFSET = 2 ** 20
const ROW = 2 ** 21
const cellAt = (x: number, y: number) => (x + OFFSET) * ROW + (y + OFFSET)
const xOf = (cell: number) => Math.floor(cell / ROW) - OFFSET
const yOf = (cell: number) => (cell % ROW) - OFFSET

type Rider = {
  id: string
  name: string
  color: number
  isBot: boolean
  isAlive: boolean
  x: number
  y: number
  dir: Dir
  turns: Dir[]
  trail: number[]
  run: number
  best: number
  kills: number
  derezzedBy: string | null
  respawnAt: number
  lastSeen: number
  // The last view sent, kept for the tick it was drawn on: polls within a tick reuse it
  view: { key: string; body: string } | null
}

const riders = new Map<string, Rider>()
const grid = new Map<number, Rider>()
// When each address last joined, for JOINS_PER_MINUTE
const joins = new Map<string, number[]>()
let tick = 0
let half = MIN_HALF
let shrinkingSince: number | null = null

const isDir = (value: unknown): value is Dir => value === 0 || value === 1 || value === 2 || value === 3
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const isInside = (x: number, y: number, margin = 0) => Math.abs(x) < half - margin && Math.abs(y) < half - margin
const isBlocked = (x: number, y: number) => !isInside(x, y) || grid.has(cellAt(x, y))
const targetHalf = () => clamp(Math.round(Math.sqrt(riders.size * AREA_PER_RIDER) / 2), MIN_HALF, MAX_HALF)

function addRider(name: string, isBot: boolean): Rider {
  const usage = (color: number) => [...riders.values()].filter(rider => rider.color === color).length
  let color = 0
  for (let candidate = 1; candidate < COLORS.length; candidate++) {
    if (usage(candidate) < usage(color)) color = candidate
  }
  const rider: Rider = {
    id: crypto.randomUUID(),
    name,
    color,
    isBot,
    isAlive: false,
    x: 0,
    y: 0,
    dir: 0,
    turns: [],
    trail: [],
    run: 0,
    best: 0,
    kills: 0,
    derezzedBy: null,
    respawnAt: 0,
    lastSeen: Date.now(),
    view: null,
  }
  riders.set(rider.id, rider)
  // A new rider makes room for themselves before they spawn
  half = Math.max(half, targetHalf())
  spawn(rider)

  return rider
}

function removeRider(rider: Rider) {
  clearTrail(rider)
  riders.delete(rider.id)
}

function clearTrail(rider: Rider) {
  for (const cell of rider.trail) {
    if (grid.get(cell) === rider) grid.delete(cell)
  }
  rider.trail = []
}

// Spawns near the riders already out there, inside the walls; when there's no
// clear spot, tries again shortly
function spawn(rider: Rider) {
  const others = [...riders.values()].filter(other => other.isAlive && other !== rider)
  const room = half - SPAWN_MARGIN
  const cx = others.length > 0 ? clamp(Math.round(average(others.map(other => other.x))), -room, room) : 0
  const cy = others.length > 0 ? clamp(Math.round(average(others.map(other => other.y))), -room, room) : 0
  const spread = 20 + 6 * Math.sqrt(others.length)

  for (let attempt = 0; attempt < 500; attempt++) {
    const reach = spread * (1 + attempt / 100)
    const angle = Math.random() * Math.PI * 2
    const distance = reach * Math.sqrt(Math.random())
    const x = cx + Math.round(Math.cos(angle) * distance)
    const y = cy + Math.round(Math.sin(angle) * distance)
    const dir = Math.floor(Math.random() * 4) as Dir
    if (isClearSpawn(x, y, dir, others)) return place(rider, x, y, dir)
  }
  rider.respawnAt = Date.now() + 500
}

function isClearSpawn(x: number, y: number, dir: Dir, others: Rider[]) {
  if (!isInside(x, y, SPAWN_MARGIN)) return false
  for (let dx = -4; dx <= 4; dx++) {
    for (let dy = -4; dy <= 4; dy++) {
      if (grid.has(cellAt(x + dx, y + dy))) return false
    }
  }
  for (let ahead = 1; ahead <= 15; ahead++) {
    if (isBlocked(x + DX[dir] * ahead, y + DY[dir] * ahead)) return false
  }

  return others.every(other => Math.abs(other.x - x) + Math.abs(other.y - y) >= 10)
}

function place(rider: Rider, x: number, y: number, dir: Dir) {
  Object.assign(rider, { isAlive: true, x, y, dir, turns: [], run: 0, derezzedBy: null })
  const cell = cellAt(x, y)
  rider.trail = [cell]
  grid.set(cell, rider)
}

function derez(rider: Rider, by: string) {
  clearTrail(rider)
  rider.isAlive = false
  rider.derezzedBy = by
  rider.respawnAt = Date.now() + RESPAWN_MS
}

function move(rider: Rider, cell: number) {
  rider.x += DX[rider.dir]
  rider.y += DY[rider.dir]
  rider.trail.push(cell)
  grid.set(cell, rider)
  rider.run += 1
  rider.best = Math.max(rider.best, rider.run)
}

// Grows to the size the lobby needs at once; shrinks only once the lobby has
// stayed smaller for a while, then a cell every few ticks
function resizeArena(now: number) {
  const target = targetHalf()
  if (target >= half) {
    half = target
    shrinkingSince = null
    return
  }
  shrinkingSince ??= now
  if (now - shrinkingSince < SHRINK_DELAY_MS || tick % SHRINK_EVERY !== 0) return

  half -= 1
  // The wall clears the trail it passes over and derezzes any rider it catches
  for (const rider of riders.values()) {
    if (rider.isAlive && !isInside(rider.x, rider.y)) {
      derez(rider, 'the closing wall')
      continue
    }
    const kept = rider.trail.filter(cell => isInside(xOf(cell), yOf(cell)))
    if (kept.length === rider.trail.length) continue
    for (const cell of rider.trail) {
      if (!isInside(xOf(cell), yOf(cell)) && grid.get(cell) === rider) grid.delete(cell)
    }
    rider.trail = kept
  }
}

// Takes the first queued turn that isn't straight on or straight back
function nextTurn(rider: Rider): Dir {
  while (rider.turns.length > 0) {
    const turn = rider.turns.shift()!
    if (turn !== rider.dir && turn !== (rider.dir + 2) % 4) return turn
  }

  return rider.dir
}

// Counts open cells reachable from (x, y), up to `limit`
function openRoom(x: number, y: number, limit: number) {
  if (isBlocked(x, y)) return 0
  const seen = new Set([cellAt(x, y)])
  const queue = [[x, y]]
  for (let i = 0; i < queue.length && seen.size < limit; i++) {
    const [qx, qy] = queue[i]
    for (let dir = 0; dir < 4; dir++) {
      const nx = qx + DX[dir]
      const ny = qy + DY[dir]
      const cell = cellAt(nx, ny)
      if (seen.has(cell) || isBlocked(nx, ny)) continue
      seen.add(cell)
      queue.push([nx, ny])
    }
  }

  return seen.size
}

function nearestRider(from: Rider, isWanted: (rider: Rider) => boolean) {
  let nearest: Rider | null = null
  let nearestDistance = Infinity
  for (const rider of riders.values()) {
    if (rider === from || !rider.isAlive || !isWanted(rider)) continue
    const distance = Math.hypot(rider.x - from.x, rider.y - from.y)
    if (distance < nearestDistance) {
      nearest = rider
      nearestDistance = distance
    }
  }

  return nearest
}

// Bots keep to open room, wobble a little, and cut in front of a nearby human
function steerBot(bot: Rider): Dir {
  const prey = nearestRider(bot, rider => !rider.isBot)
  const isHunting = prey !== null && Math.hypot(prey.x - bot.x, prey.y - bot.y) < BOT_RANGE
  let choice = bot.dir
  let bestScore = -Infinity
  for (const dir of [bot.dir, (bot.dir + 1) % 4, (bot.dir + 3) % 4] as Dir[]) {
    const x = bot.x + DX[dir]
    const y = bot.y + DY[dir]
    const room = openRoom(x, y, 150)
    if (room === 0) continue
    let score = room + (dir === bot.dir ? 4 : 0) + Math.random() * 8
    if (isHunting && room > 60) {
      const tx = prey.x + DX[prey.dir] * 6
      const ty = prey.y + DY[prey.dir] * 6
      score += (Math.hypot(bot.x - tx, bot.y - ty) - Math.hypot(x - tx, y - ty)) * 10
    }
    if (score > bestScore) {
      bestScore = score
      choice = dir
    }
  }

  return choice
}

function step() {
  tick += 1
  const now = Date.now()
  if (tick % 600 === 0) {
    for (const [address, times] of joins) {
      if (times.every(at => now - at >= 60_000)) joins.delete(address)
    }
  }
  for (const rider of [...riders.values()]) {
    if (!rider.isBot && now - rider.lastSeen > IDLE_MS) removeRider(rider)
  }
  resizeArena(now)
  for (const rider of riders.values()) {
    if (!rider.isAlive && now >= rider.respawnAt) spawn(rider)
  }

  const moving = [...riders.values()].filter(rider => rider.isAlive)
  for (const rider of moving) rider.dir = rider.isBot ? steerBot(rider) : nextTurn(rider)

  // Every crash is found before any trail is cleared, so riders that hit each other on one tick both go
  const crashes: { rider: Rider; by: string; killer: Rider | null }[] = []
  const claims = new Map<number, Rider[]>()
  for (const rider of moving) {
    const x = rider.x + DX[rider.dir]
    const y = rider.y + DY[rider.dir]
    if (!isInside(x, y)) {
      crashes.push({ rider, by: 'the arena wall', killer: null })
      continue
    }
    const cell = cellAt(x, y)
    claims.set(cell, [...(claims.get(cell) ?? []), rider])
  }
  for (const [cell, claimants] of claims) {
    const owner = grid.get(cell)
    if (owner === undefined && claimants.length === 1) {
      move(claimants[0], cell)
      continue
    }
    for (const rider of claimants) {
      if (owner === undefined) crashes.push({ rider, by: 'a head-on', killer: null })
      else if (owner === rider) crashes.push({ rider, by: 'your own trail', killer: null })
      else crashes.push({ rider, by: `${owner.name}'s trail`, killer: owner })
    }
  }
  for (const { rider, by, killer } of crashes) {
    if (killer !== null) killer.kills += 1
    derez(rider, by)
  }
}

function frameFor(rider: Rider, w: number, h: number): Frame {
  const x0 = rider.x - Math.floor(w / 2)
  const y0 = rider.y - Math.floor(h / 2)
  const cells: string[] = []
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const owner = grid.get(cellAt(x, y))
      if (owner === undefined) cells.push('.')
      else {
        const isHead = owner.isAlive && owner.x === x && owner.y === y
        cells.push(String.fromCharCode((isHead ? 97 : 65) + owner.color))
      }
    }
  }
  const nearest = nearestRider(rider, () => true)
  const standings = [...riders.values()]
    .sort((a, b) => b.best - a.best || b.kills - a.kills)
    .slice(0, 5)
    .map(other => ({ name: other.name, color: other.color, best: other.best, kills: other.kills, isYou: other === rider }))

  return {
    tick,
    x0,
    y0,
    w,
    h,
    cells: cells.join(''),
    colors: COLORS,
    arena: { half, isShrinking: shrinkingSince !== null && Date.now() - shrinkingSince >= SHRINK_DELAY_MS },
    you: {
      name: rider.name,
      color: rider.color,
      isAlive: rider.isAlive,
      run: rider.run,
      best: rider.best,
      kills: rider.kills,
      derezzedBy: rider.derezzedBy,
      respawnMs: Math.max(0, rider.respawnAt - Date.now()),
    },
    riders: riders.size,
    standings,
    nearest: nearest && { name: nearest.name, color: nearest.color, dx: nearest.x - rider.x, dy: nearest.y - rider.y },
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status })
const humans = () => [...riders.values()].filter(rider => !rider.isBot).length

// Behind a host's proxy the client's address is the first in X-Forwarded-For
function addressOf(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || server.requestIP(request)?.address || 'unknown'
}

function mayJoin(address: string, now: number) {
  const recent = (joins.get(address) ?? []).filter(at => now - at < 60_000)
  if (recent.length >= JOINS_PER_MINUTE) return false
  joins.set(address, [...recent, now])
  return true
}

// The view for one rider, drawn at most once a tick however often they poll
function viewFor(rider: Rider, w: number, h: number) {
  const key = `${tick}:${w}x${h}`
  if (rider.view?.key !== key) {
    const frame = frameFor(rider, w, h)
    rider.view = { key, body: JSON.stringify({ ...frame, cells: encodeCells(frame.cells) }) }
  }

  return new Response(rider.view.body, { headers: { 'content-type': 'application/json' } })
}
const cleanName = (value: unknown) =>
  String(value ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'rider'

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return typeof body === 'object' && body !== null ? body : {}
  } catch {
    return {}
  }
}

const server = Bun.serve({
  hostname: flags.host,
  port: Number(process.env.PORT ?? flags.port),
  maxRequestBodySize: MAX_BODY_BYTES,
  async fetch(request) {
    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname}`

    if (route === 'GET /health') {
      return json({ ok: true, protocol: PROTOCOL, riders: riders.size, humans: humans(), tick, half, target: targetHalf() })
    }

    if (route === 'POST /join') {
      if (humans() >= MAX_HUMANS) return json({ error: 'the lobby is full' }, 503)
      if (!mayJoin(addressOf(request), Date.now())) return json({ error: 'too many joins; wait a minute' }, 429)
      const rider = addRider(cleanName((await readBody(request)).name), false)
      return json({ id: rider.id, color: rider.color, protocol: PROTOCOL })
    }

    if (route === 'GET /view') {
      const rider = riders.get(url.searchParams.get('id') ?? '')
      if (rider === undefined) return json({ error: 'unknown rider' }, 404)
      rider.lastSeen = Date.now()
      const w = clamp(Number(url.searchParams.get('w')) || 80, 1, MAX_VIEW.w)
      const h = clamp(Number(url.searchParams.get('h')) || 48, 1, MAX_VIEW.h)
      return viewFor(rider, Math.round(w), Math.round(h))
    }

    if (route === 'POST /turn' || route === 'POST /leave') {
      const body = await readBody(request)
      const rider = riders.get(String(body.id))
      if (rider === undefined) return json({ error: 'unknown rider' }, 404)
      if (route === 'POST /leave') {
        removeRider(rider)
        return json({ ok: true })
      }
      rider.lastSeen = Date.now()
      const turns = Array.isArray(body.turns) ? body.turns.filter(isDir) : []
      rider.turns = [...rider.turns, ...turns].slice(-4)
      return json({ ok: true })
    }

    return json({ error: 'not found' }, 404)
  },
})

for (let i = 0; i < Number(flags.bots); i++) {
  const suffix = i < BOT_NAMES.length ? '' : `-${Math.floor(i / BOT_NAMES.length) + 1}`
  addRider(`${BOT_NAMES[i % BOT_NAMES.length]}${suffix}`, true)
}
setInterval(step, TICK_MS)
console.log(`Light-cycle lobby on http://${server.hostname}:${server.port} with ${flags.bots} bots`)
