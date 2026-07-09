// A small PDF content-stream tokenizer used to find/remove text drawn in an
// *invisible* text render mode (Tr 3 / Tr 7) — i.e. hidden text such as an
// adversary's poisoned OCR layer. Pure byte processing, no mupdf/Electron, so
// it is testable in plain Node.
//
// Scope (v1): operates on a page's (concatenated) content stream. Text drawn
// inside referenced form XObjects is NOT descended into — those are rare for
// hidden-text layers, which are normally placed directly on the page.
//
// The filter never rewrites arbitrary bytes: it only *deletes* the byte spans of
// the targeted text-showing operators (and their operands), copying everything
// else verbatim. That keeps the output structurally identical apart from the
// removed text.

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIM = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25
]) // ( ) < > [ ] { } / %

function isWs(b: number): boolean {
  return WS.has(b)
}
function isDelim(b: number): boolean {
  return DELIM.has(b)
}

type TokKind = 'operand' | 'operator' | 'arrayStart' | 'arrayEnd'
interface Tok {
  kind: TokKind
  start: number
  end: number
  text?: string // for operators and numbers
  num?: number // numeric value if the token is a number
}

/** Text render mode 3 (invisible) and 7 (invisible + clip) hide the glyphs. */
function isInvisibleMode(mode: number): boolean {
  return mode === 3 || mode === 7
}

/**
 * Tokenize far enough to drive the filter: numbers, names, strings (literal and
 * hex), arrays (as a single operand span), dict delimiters, and operators.
 * Comments are treated as whitespace. Returns tokens in source order.
 */
function tokenize(buf: Uint8Array): Tok[] {
  const toks: Tok[] = []
  const n = buf.length
  let i = 0

  const readString = (start: number): number => {
    // buf[start] === '(' ; return index just past the matching ')'
    let depth = 0
    let j = start
    while (j < n) {
      const c = buf[j]
      if (c === 0x5c) {
        j += 2
        continue
      } // backslash escape
      if (c === 0x28) depth++
      else if (c === 0x29) {
        depth--
        if (depth === 0) return j + 1
      }
      j++
    }
    return n
  }

  const readName = (start: number): number => {
    let j = start + 1
    while (j < n && !isWs(buf[j]) && !isDelim(buf[j])) j++
    return j
  }

  const readRegular = (start: number): number => {
    // number or operator keyword: run of non-ws, non-delim bytes
    let j = start
    while (j < n && !isWs(buf[j]) && !isDelim(buf[j])) j++
    return j
  }

  const parseNumber = (s: string): number | undefined => {
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) ? parseFloat(s) : undefined
  }

  // Scan an array [ ... ] as one operand span, respecting strings inside.
  const readArray = (start: number): number => {
    let j = start + 1
    while (j < n) {
      const c = buf[j]
      if (c === 0x5d) return j + 1 // ]
      if (c === 0x28) {
        j = readString(j)
        continue
      }
      if (c === 0x3c) {
        // hex string <...> (not dict, arrays don't hold dicts in TJ)
        let k = j + 1
        while (k < n && buf[k] !== 0x3e) k++
        j = k + 1
        continue
      }
      if (c === 0x25) {
        // comment to EOL
        while (j < n && buf[j] !== 0x0a && buf[j] !== 0x0d) j++
        continue
      }
      j++
    }
    return n
  }

  while (i < n) {
    const c = buf[i]
    if (isWs(c)) {
      i++
      continue
    }
    if (c === 0x25) {
      // comment
      while (i < n && buf[i] !== 0x0a && buf[i] !== 0x0d) i++
      continue
    }
    if (c === 0x28) {
      const end = readString(i)
      toks.push({ kind: 'operand', start: i, end })
      i = end
      continue
    }
    if (c === 0x3c) {
      if (buf[i + 1] === 0x3c) {
        // << dict open — treat as operand-structural, skip as operator-ish
        toks.push({ kind: 'operator', start: i, end: i + 2, text: '<<' })
        i += 2
        continue
      }
      // hex string
      let j = i + 1
      while (j < n && buf[j] !== 0x3e) j++
      toks.push({ kind: 'operand', start: i, end: j + 1 })
      i = j + 1
      continue
    }
    if (c === 0x3e) {
      if (buf[i + 1] === 0x3e) {
        toks.push({ kind: 'operator', start: i, end: i + 2, text: '>>' })
        i += 2
        continue
      }
      i++ // stray '>'
      continue
    }
    if (c === 0x5b) {
      const end = readArray(i)
      toks.push({ kind: 'operand', start: i, end })
      i = end
      continue
    }
    if (c === 0x5d) {
      i++ // handled inside readArray, stray ']'
      continue
    }
    if (c === 0x2f) {
      const end = readName(i)
      // Keep the name text (without the leading '/') so `gs` can resolve which
      // ExtGState (and thus which alpha) it selects.
      toks.push({
        kind: 'operand',
        start: i,
        end,
        text: String.fromCharCode(...buf.slice(i + 1, end))
      })
      i = end
      continue
    }
    if (c === 0x7b || c === 0x7d) {
      // { } — PostScript calc delimiters (Type 4 funcs); treat as operator token
      toks.push({ kind: 'operator', start: i, end: i + 1, text: String.fromCharCode(c) })
      i++
      continue
    }
    // regular: number or operator keyword
    const end = readRegular(i)
    const text = String.fromCharCode(...buf.slice(i, end))
    const num = parseNumber(text)
    if (num !== undefined) toks.push({ kind: 'operand', start: i, end, num })
    else toks.push({ kind: 'operator', start: i, end, text })
    i = end
  }
  return toks
}

const SHOW_OPS = new Set(['Tj', 'TJ', "'", '"'])

export interface FilterResult {
  output: Uint8Array
  /** How many text-showing operators were removed. */
  removed: number
}

/** Text render modes that fill the glyphs (so their fill colour is what shows). */
function isFillMode(mode: number): boolean {
  return mode === 0 || mode === 2 || mode === 4 || mode === 6
}

/** Near-white as gray / rgb / cmyk — i.e. text that vanishes on a white page. */
function whiteGray(v: number): boolean {
  return v >= 0.95
}
function whiteRgb(r: number, g: number, b: number): boolean {
  return r >= 0.95 && g >= 0.95 && b >= 0.95
}
function whiteCmyk(c: number, m: number, y: number, k: number): boolean {
  return c <= 0.05 && m <= 0.05 && y <= 0.05 && k <= 0.05
}

interface GsColor {
  mode: number
  fillWhite: boolean
  fillAlpha: number
}

/**
 * Remove text-showing operators (and their operands) that are HIDDEN
 * (`target: 'invisible'`) or NOT hidden (`target: 'visible'`). "Hidden" means
 * an invisible text render mode (Tr 3/7), OR white/near-white fill text, OR text
 * drawn with near-zero fill alpha (transparent via an ExtGState `/ca`) — all
 * common ways to smuggle text past the eye while it still extracts for search/AI.
 * `gsAlpha` maps each ExtGState resource name to its `/ca` (fill alpha) so the
 * `gs` operator can be interpreted. The inverse ('visible') isolates the hidden
 * text for preview/extraction.
 */
export function filterContentStream(
  buf: Uint8Array,
  target: 'invisible' | 'visible',
  gsAlpha: Record<string, number> = {}
): FilterResult {
  const toks = tokenize(buf)
  const removeRanges: Array<[number, number]> = []

  let mode = 0
  let fillWhite = false // default fill colour is black
  let fillAlpha = 1 // default fully opaque
  const gs: GsColor[] = []
  let operandStart = -1
  let nums: number[] = []
  let lastName: string | undefined
  let inlineImage = false
  let removed = 0

  for (let t = 0; t < toks.length; t++) {
    const tk = toks[t]

    // Skip inline-image binary: once we saw `ID`, ignore everything until `EI`.
    if (inlineImage) {
      if (tk.kind === 'operator' && tk.text === 'EI') {
        inlineImage = false
        operandStart = -1
        nums = []
        lastName = undefined
      }
      continue
    }

    if (tk.kind === 'operand') {
      if (operandStart === -1) operandStart = tk.start
      if (tk.num !== undefined) nums.push(tk.num)
      else if (tk.text !== undefined) lastName = tk.text
      continue
    }

    // operator
    const op = tk.text ?? ''
    if (op === 'q') {
      gs.push({ mode, fillWhite, fillAlpha })
    } else if (op === 'Q') {
      const prev = gs.pop()
      if (prev) {
        mode = prev.mode
        fillWhite = prev.fillWhite
        fillAlpha = prev.fillAlpha
      }
    } else if (op === 'gs') {
      if (lastName !== undefined && gsAlpha[lastName] !== undefined) {
        fillAlpha = gsAlpha[lastName]
      }
    } else if (op === 'Tr') {
      if (nums.length > 0) mode = Math.trunc(nums[nums.length - 1])
    } else if (op === 'g') {
      if (nums.length >= 1) fillWhite = whiteGray(nums[nums.length - 1])
    } else if (op === 'rg') {
      if (nums.length >= 3) fillWhite = whiteRgb(nums[nums.length - 3], nums[nums.length - 2], nums[nums.length - 1])
    } else if (op === 'k') {
      if (nums.length >= 4) fillWhite = whiteCmyk(nums[nums.length - 4], nums[nums.length - 3], nums[nums.length - 2], nums[nums.length - 1])
    } else if (op === 'sc' || op === 'scn') {
      // Set colour in the current fill colourspace. Interpret plain numeric
      // operands by arity; anything else (patterns) → treat as not-white.
      if (nums.length === 1) fillWhite = whiteGray(nums[0])
      else if (nums.length === 3) fillWhite = whiteRgb(nums[0], nums[1], nums[2])
      else if (nums.length === 4) fillWhite = whiteCmyk(nums[0], nums[1], nums[2], nums[3])
      else fillWhite = false
    } else if (op === 'ID') {
      inlineImage = true
      operandStart = -1
      nums = []
      lastName = undefined
      continue
    } else if (SHOW_OPS.has(op)) {
      const hidden =
        isInvisibleMode(mode) ||
        (isFillMode(mode) && (fillWhite || fillAlpha <= 0.05))
      const hit = target === 'invisible' ? hidden : !hidden
      if (hit) {
        const start = operandStart === -1 ? tk.start : operandStart
        removeRanges.push([start, tk.end])
        removed++
      }
    }
    operandStart = -1
    nums = []
    lastName = undefined
  }

  if (removeRanges.length === 0) return { output: buf, removed: 0 }

  // Splice out removed ranges (already in ascending, non-overlapping order).
  let outLen = buf.length
  for (const [s, e] of removeRanges) outLen -= e - s
  const out = new Uint8Array(outLen)
  let w = 0
  let read = 0
  for (const [s, e] of removeRanges) {
    out.set(buf.subarray(read, s), w)
    w += s - read
    read = e
  }
  out.set(buf.subarray(read), w)
  return { output: out, removed }
}
