// The lobby's wire format, shared by server/server.ts and register.tsx.

// Bumped when the server and the mod stop understanding each other's frames
export const PROTOCOL = 1

// 0 up, 1 right, 2 down, 3 left
export type Dir = 0 | 1 | 2 | 3

export type Standing = {
  name: string
  color: number
  best: number
  kills: number
  isYou: boolean
}

export type Frame = {
  tick: number
  // World coordinates of the view's top-left cell
  x0: number
  y0: number
  w: number
  h: number
  // One character per cell, row by row: '.' empty, 'A' + color a trail, 'a' + color a head.
  // On the wire this is run-length encoded (encodeCells); the mod decodes it on arrival.
  cells: string
  colors: string[]
  // The arena runs from -half to half on both axes; the wall closes in while isShrinking
  arena: { half: number; isShrinking: boolean }
  you: {
    name: string
    color: number
    isAlive: boolean
    run: number
    best: number
    kills: number
    derezzedBy: string | null
    respawnMs: number
  }
  riders: number
  standings: Standing[]
  nearest: { name: string; color: number; dx: number; dy: number } | null
}

// A run of one cell character becomes the character and its count, when the count
// is more than one: '.40A3' is 40 empty cells, then 3 trail cells of color A. Cell
// characters are never digits, so a count can't be misread. Mostly-empty frames
// shrink about tenfold.
export function encodeCells(cells: string) {
  const parts: string[] = []
  for (let start = 0; start < cells.length; ) {
    let end = start + 1
    while (end < cells.length && cells[end] === cells[start]) end += 1
    parts.push(end - start > 1 ? `${cells[start]}${end - start}` : cells[start])
    start = end
  }

  return parts.join('')
}

export function decodeCells(encoded: string) {
  const parts: string[] = []
  for (let start = 0; start < encoded.length; ) {
    let end = start + 1
    while (end < encoded.length && encoded[end] >= '0' && encoded[end] <= '9') end += 1
    parts.push(encoded[start].repeat(end > start + 1 ? Number(encoded.slice(start + 1, end)) : 1))
    start = end
  }

  return parts.join('')
}
