/**
 * dsh-trajectory-digest — keep oversized tool output out of the context window.
 *
 * Two layers, one policy:
 *  - age layer: a `tool/result` surface replacement rewrites a tool result older
 *    than `keepRecent` requests into a bounded digest, so the recent working set
 *    keeps full fidelity and older history shrinks. The original event stays in
 *    the log; only the model-visible surface node changes.
 *  - write layer: a single extremely large result is bounded immediately,
 *    because the step that produced it still has to fit in one request.
 *
 * Digest bodies are chosen per tool family (build/test outcome, match counts,
 * listings, titles) instead of a blind head-slice. The complete original always
 * lands in the spill directory before it is replaced, and the digest carries a
 * readable path back to every detail.
 *
 * @module dsh-trajectory-digest
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'trajectory-digest'
/** Services this plugin registers against. */
export const inject = ['tools']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIGEST_DIR = path.join(DSH_HOME, 'trajectory-digest')
const SPILL_DIR = path.join(DIGEST_DIR, 'spill')
const STATS_FILE = path.join(DIGEST_DIR, 'stats.json')
const DIAG_FILE = path.join(DIGEST_DIR, 'diagnostics.log')

/** Results the model needs verbatim: file bodies it will edit or quote. */
const NEVER_DIGEST = new Set(['read', 'edit', 'write', 'str_replace_editor', 'ask_user_question', 'todo_write', 'present', 'skill', 'exit_plan_mode'])

const ERROR_LINE = /(error|Error|ERROR|FAIL|failed|cannot|denied|not found|No such|Traceback|Exception|refused|timed out)/
const DIGEST_PREFIX = '[digest] '

/* ------------------------------------------------------------------ helpers */

function diag(where, error) {
  try {
    fs.mkdirSync(DIGEST_DIR, { recursive: true })
    fs.appendFileSync(DIAG_FILE, `${new Date().toISOString()} ${where}: ${error && error.message ? error.message : String(error)}\n`)
  } catch { /* ignore */ }
}

function head(text, limit) {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const at = cut.lastIndexOf('\n')
  return at > limit * 0.5 ? cut.slice(0, at) : cut
}

function tail(text, limit) {
  if (text.length <= limit) return text
  const cut = text.slice(-limit)
  const at = cut.indexOf('\n')
  return at >= 0 ? cut.slice(at + 1) : cut
}

function pickError(text, limit) {
  const picked = []
  for (const line of text.split('\n')) {
    if (!ERROR_LINE.test(line)) continue
    picked.push(line.trim())
    if (picked.join('\n').length > limit || picked.length >= 6) break
  }
  return picked.length === 0 ? head(text, limit) : head(picked.join('\n'), limit)
}

function summarizeArgs(toolName, args) {
  const value = args !== null && typeof args === 'object' ? args : {}
  const pick = value.description || value.command || value.file_path || value.pattern || value.url || value.query || value.name || ''
  const text = String(pick).replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  return text.length > 72 ? `"${text.slice(0, 72)}…"` : `"${text}"`
}

/** Set by apply() so the spill writer can trigger bounded retention. */
let afterSpillWrite = null

function writeSpill(callId, toolName, text) {
  try {
    fs.mkdirSync(SPILL_DIR, { recursive: true })
    const safe = `${Date.now()}-${String(toolName).replace(/[^A-Za-z0-9_.-]/g, '_')}-${String(callId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(-24)}.txt`
    const file = path.join(SPILL_DIR, safe)
    fs.writeFileSync(file, text)
    if (afterSpillWrite !== null) afterSpillWrite()
    return file
  } catch {
    return undefined
  }
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n')
}

/* --------------------------------------------------------------- extractors */

/** Build/test tooling states its verdict on one recognizable line. */
const OUTCOME_LINES = [
  /^(?:Tests?:|Test Suites?:|Test Files?:).*/m,
  /^\s*(?:✓|✔|PASS|OK|Build succeeded|Successfully built|Done in).*/m,
  /^\s*\d+\s+(?:passed|failed|errors?|warnings?)\b.*/im,
  /^(?:added|installed|removed|updated|changed)\s+\d+\s+packages?.*/im,
  /^npm (?:ERR!|error).*/m,
]

function looksLikeListing(lines) {
  const sample = lines.slice(0, 25)
  if (sample.length < 20) return false
  const short = sample.filter((line) => line.trim() !== '' && line.trim().length < 80).length
  const spaced = sample.filter((line) => line.includes(' ') && line.trim().length > 60).length
  return short >= sample.length * 0.8 && spaced === 0
}

function summarizeBash(text, isError, budget) {
  if (isError) return { mode: 'error', body: pickError(text, budget) }
  for (const pattern of OUTCOME_LINES) {
    const match = text.match(pattern)
    if (match !== null) return { mode: 'outcome', body: head(match[0].trim(), budget) }
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (looksLikeListing(lines)) {
    return { mode: 'listing', body: `${lines.length}L: ${lines.slice(0, 3).join(' / ')}` }
  }
  const half = Math.max(80, Math.floor(budget * 0.45))
  return { mode: 'head+tail', body: `${head(text, half)}\n…\n${tail(text, half)}` }
}

function summarizeGrep(text, budget) {
  const count = text.match(/Found\s+\d+\s+of\s+\d+\s+matches?/i) || text.match(/\b\d+\s+matches?\b/i)
  const files = []
  for (const line of text.split('\n')) {
    const match = line.match(/^([^\s:][^:]{0,200}?):\d+[:|-]/)
    if (match === null) continue
    const name = path.basename(match[1])
    if (!files.includes(name)) files.push(name)
    if (files.length >= 3) break
  }
  const body = [count === null ? '' : count[0], files.length === 0 ? '' : `files: ${files.join(', ')}`].filter(Boolean).join(' · ')
  return { mode: 'matches', body: head(body === '' ? text : body, budget) }
}

function summarizeGlob(text, budget) {
  const names = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return { mode: 'paths', body: `${names.length} paths: ${names.slice(0, 3).join(' / ')}`.slice(0, budget) }
}

function summarizeWeb(text, budget) {
  const title = text.match(/^\s*#\s+(.+)$/m) || text.match(/<title>([^<]+)<\/title>/i)
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '') || ''
  return { mode: 'extract', body: head(title === null ? firstLine : title[1].trim(), budget) }
}

function summarizeGeneric(text, isError, budget) {
  if (isError) return { mode: 'error', body: pickError(text, budget) }
  const half = Math.max(80, Math.floor(budget * 0.5))
  return { mode: 'head+tail', body: `${head(text, half)}\n…\n${tail(text, half)}` }
}

function summarizeByTool(toolName, text, isError, budget) {
  const name = String(toolName || '')
  if (name === 'bash' || name === 'pwsh') return summarizeBash(text, isError, budget)
  if (name === 'grep') return summarizeGrep(text, budget)
  if (name === 'glob') return summarizeGlob(text, budget)
  if (name === 'web_fetch' || name === 'web_search' || name.startsWith('mcp__web')) return summarizeWeb(text, budget)
  return summarizeGeneric(text, isError, budget)
}

/**
 * Compose one digest: a self-describing header, the per-family body, and a
 * pointer the model can follow when it really needs the whole thing.
 */
function buildDigest({ toolName, argsSummary, text, isError, budget, maxChars, spillPath }) {
  const summary = summarizeByTool(toolName, text, isError, Math.max(120, budget))
  const lines = text.split('\n').length
  const header = `${DIGEST_PREFIX}${isError ? '✗' : '✓'} ${toolName}${argsSummary === '' ? '' : ` ${argsSummary}`} → ${lines}L/${text.length}c · ${summary.mode}`
  let digest = `${header}\n${summary.body}`
  if (spillPath !== undefined) digest += `\n… full: ${spillPath}`
  if (digest.length > maxChars) digest = `${digest.slice(0, maxChars - 1)}…`
  return digest
}

/* -------------------------------------------------------------------- apply */

/**
 * Mount the digest policy.
 * @param ctx - plugin context.
 * @param config - row configuration.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const mode = config.mode === 'write' ? 'write' : 'age'
  const keepRecent = Number.isSafeInteger(config.keepRecent) ? config.keepRecent : 2
  const minChars = Number.isSafeInteger(config.minChars) ? config.minChars : 1600
  const digestChars = Number.isSafeInteger(config.digestChars) ? config.digestChars : 420
  const hugeChars = Number.isSafeInteger(config.hugeChars) ? config.hugeChars : 40000
  const maxDigestChars = Number.isSafeInteger(config.maxDigestChars) ? config.maxDigestChars : 1200
  const headChars = Number.isSafeInteger(config.headChars) ? config.headChars : 700
  const errorChars = Number.isSafeInteger(config.errorChars) ? config.errorChars : 900
  const spill = config.spill !== false
  const never = new Set(Array.isArray(config.neverDigest) ? [...NEVER_DIGEST, ...config.neverDigest] : [...NEVER_DIGEST])

  let stats = {}
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))
    if (raw !== null && typeof raw === 'object') stats = raw
  } catch { /* first run */ }
  let saveTimer
  function save() {
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      try {
        fs.mkdirSync(DIGEST_DIR, { recursive: true })
        fs.writeFileSync(`${STATS_FILE}.tmp`, JSON.stringify(stats, null, 2))
        fs.renameSync(`${STATS_FILE}.tmp`, STATS_FILE)
      } catch (error) { diag('stats', error) }
    }, 800)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }
  function record(sessionId, toolName, before, after) {
    const bucket = stats[sessionId] ?? { inChars: 0, outChars: 0, digests: 0, tools: {} }
    bucket.inChars += before
    bucket.outChars += after
    bucket.digests += 1
    const perTool = bucket.tools[toolName] ?? { inChars: 0, outChars: 0, n: 0 }
    perTool.inChars += before
    perTool.outChars += after
    perTool.n += 1
    bucket.tools[toolName] = perTool
    stats[sessionId] = bucket
    save()
  }

  /* write layer: only results too large for one request to hold comfortably */
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      if (never.has(exec.name)) return decision
      const content = decision.content ?? result.content
      if (!Array.isArray(content) || content.length === 0) return decision
      if (content.some((block) => block === null || typeof block !== 'object' || block.type !== 'text')) return decision
      const original = textOf(content)
      const threshold = liveMode() === 'write' ? liveNum('minChars', minChars) : liveNum('hugeChars', hugeChars)
      if (original.length < threshold) return decision
      const isError = result.isError === true
      const file = spill ? writeSpill(exec.callId, exec.name, original) : undefined
      const digest = buildDigest({
        toolName: exec.name,
        argsSummary: summarizeArgs(exec.name, exec.arguments),
        text: original,
        isError,
        budget: isError ? errorChars : headChars,
        maxChars: maxDigestChars,
        spillPath: file,
      })
      if (digest.length >= original.length) return decision
      record(String(exec.agent?.session?.id ?? 'unknown'), exec.name, original.length, digest.length)
      return { kind: 'accept', content: [{ type: 'text', text: digest }] }
    } catch (error) {
      diag('post-execute', error)
      return decision
    }
  }, { prepend: true })

  /* live config: mode and thresholds take effect on the next tool call, no reload */
  const LIVE_CONFIG = path.join(DIGEST_DIR, 'config.json')
  let liveCache = { at: 0, value: {} }
  function live() {
    const now = Date.now()
    if (now - liveCache.at < 500 && liveCache.at !== 0) return liveCache.value
    let extra = {}
    try {
      const raw = JSON.parse(fs.readFileSync(LIVE_CONFIG, 'utf8'))
      if (raw !== null && typeof raw === 'object') extra = raw
    } catch { extra = {} }
    liveCache = { at: now, value: { ...config, ...extra } }
    if (liveCache.logged !== true) {
      liveCache.logged = true
      diag('live-config', `file=${JSON.stringify(extra)} row=${JSON.stringify({ mode: config.mode })} dir=${DIGEST_DIR}`)
    }
    return liveCache.value
  }
  function liveNum(key, fallback) {
    const value = live()[key]
    return Number.isSafeInteger(value) ? value : fallback
  }
  function liveMode() {
    return live().mode === 'write' ? 'write' : 'age'
  }

  /* spill retention: age + file count + total bytes, enforced lazily on writes */
  let spillWrites = 0
  let pruning = false
  function pruneSpill() {
    if (pruning) return
    pruning = true
    try {
      const conf = live()
      const maxFiles = Number.isSafeInteger(conf.spillMaxFiles) ? conf.spillMaxFiles : 400
      const maxAgeMs = (Number.isFinite(conf.spillMaxAgeDays) ? conf.spillMaxAgeDays : 7) * 86_400_000
      const maxBytes = Number.isSafeInteger(conf.spillMaxBytes) ? conf.spillMaxBytes : 256 * 1024 * 1024
      let names = []
      try {
        names = fs.readdirSync(SPILL_DIR)
      } catch {
        return
      }
      const files = []
      let total = 0
      for (const name of names) {
        const full = path.join(SPILL_DIR, name)
        try {
          const stat = fs.statSync(full)
          if (!stat.isFile()) continue
          files.push({ full, size: stat.size, at: stat.mtimeMs })
          total += stat.size
        } catch { /* raced with another writer */ }
      }
      const now = Date.now()
      files.sort((a, b) => a.at - b.at)
      let removed = 0
      let freed = 0
      for (const file of files) {
        const tooOld = now - file.at > maxAgeMs
        const tooMany = files.length - removed > maxFiles
        const tooBig = total - freed > maxBytes
        if (!tooOld && !tooMany && !tooBig) break
        if (removed >= 500) break
        try {
          fs.unlinkSync(file.full)
          removed += 1
          freed += file.size
        } catch { /* already gone */ }
      }
      if (removed > 0) diag('spill-prune', `removed=${removed} freed=${Math.round(freed / 1024)}KiB left=${files.length - removed}`)
    } catch (error) {
      diag('spill-prune', error)
    } finally {
      pruning = false
    }
  }
  afterSpillWrite = () => {
    spillWrites += 1
    if (spillWrites % 20 === 1) queueMicrotask(pruneSpill)
  }
  queueMicrotask(pruneSpill)

  /* age layer: replace old tool/result surface nodes with digests, no projection needed.
     The planner registers unconditionally; liveMode() gates it per step so a
     config.json flip works without reloading the plugin. */
  const planning = new Set()

  function planSession(session) {
    const nodes = session.surface?.nodes ?? []
    if (nodes.length === 0) return
    let assistantsAfter = 0
    const picked = []
    const cap = liveNum('maxEntriesPerRecord', 8)
    const keep = liveNum('keepRecent', keepRecent)
    const minCharsLive = liveNum('minChars', minChars)
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const seq = nodes[index]
      const event = session.eventAt(seq)
      if (event === undefined) continue
      if (event.type === 'assistant/message') {
        assistantsAfter += 1
        continue
      }
      if (event.type !== 'tool/result') continue
      if (assistantsAfter < keep) continue
      const message = event.data?.message
      const text = textOf(message?.content)
      if (text.startsWith(DIGEST_PREFIX)) continue
      if (text.length < minCharsLive) continue
      picked.push({ seq, event, text, isError: message?.isError === true })
      if (picked.length >= cap) break
    }
    for (const item of picked) {
      try {
        const file = spill ? writeSpill(`age-${item.seq}`, 'result', item.text) : undefined
        const digest = buildDigest({
          toolName: 'result',
          argsSummary: '',
          text: item.text,
          isError: item.isError,
          budget: digestChars,
          maxChars: maxDigestChars,
          spillPath: file,
        })
        if (digest.length >= item.text.length) continue
        const next = {
          ...item.event.data,
          message: { ...item.event.data.message, content: [{ type: 'text', text: digest }] },
        }
        session.append('tool/result', next, {
          surfaceOp: { op: 'replace', startSeq: item.seq, endSeq: item.seq },
          sourceEventSeqs: [item.seq],
        })
        record(String(session.id), 'aged-result', item.text.length, digest.length)
      } catch (error) {
        diag('age-replace', error)
      }
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (event.type !== 'step/end') return
      if (liveMode() !== 'age') return
      const id = String(session.id)
      if (planning.has(id)) return
      planning.add(id)
      queueMicrotask(() => {
        try {
          planSession(session)
        } catch (error) {
          diag('plan', error)
        } finally {
          planning.delete(id)
        }
      })
    } catch (error) { diag('session-event', error) }
  })
}
