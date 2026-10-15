import {
  ANALYSIS_STATUSES,
  MAX_DONE_ITEMS,
  NOW_MAX_LENGTH,
  SPEECH_MAX_LENGTH,
  STEP_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  TURN_DIGEST_MAX_LENGTH,
  TURN_STEP_MAX_LENGTH,
  normalizeTitle,
  type Analysis,
  type TurnDigest,
} from "../../shared/types";

/* eslint-disable no-control-regex -- these patterns match terminal control bytes. */
const OSC_SEQUENCE_PATTERN = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g;
const STRING_SEQUENCE_PATTERN = /(?:\u001b[P_^X]|\u0090|\u0098|\u009e|\u009f)[\s\S]*?(?:\u001b\\|\u009c)/g;
const CSI_SEQUENCE_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const ESCAPE_SEQUENCE_PATTERN = /\u001b[ -/]*[0-~]/g;

function stripAnsi(value: string): string {
  return value
    .replace(OSC_SEQUENCE_PATTERN, "")
    .replace(STRING_SEQUENCE_PATTERN, "")
    .replace(CSI_SEQUENCE_PATTERN, "")
    .replace(ESCAPE_SEQUENCE_PATTERN, "");
}

export const MAX_ANALYSIS_TEXT_LENGTH = 4_000
export const MAX_ANALYSIS_LIST_ITEMS = 20

function analysisTitle(record: Record<string, unknown>): string {
  const value = record.title
  if (value === undefined) {
    // Older analyzers did not return a title; keep their results readable while
    // new runs use the required schema field.
    return normalizeTitle(text(record, 'goal')) ?? '未命名会话'
  }
  if (
    typeof value !== 'string' ||
    value.length > TITLE_MAX_LENGTH ||
    /[\r\n]/.test(value)
  ) {
    throw new Error('分析结果字段 title 无效')
  }
  const normalized = normalizeTitle(value)
  if (!normalized) {
    throw new Error('分析结果字段 title 无效')
  }
  return normalized
}

function clipLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized
}

/** Optional for older analyzers; when present it must be a string, and is trimmed to `maxLength`. */
function optionalLine(
  record: Record<string, unknown>,
  key: string,
  maxLength: number
): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`分析结果字段 ${key} 无效`)
  }
  return clipLine(value, maxLength) || undefined
}

/** Optional for older analyzers; items are trimmed to one short line each. */
function analysisDone(record: Record<string, unknown>): string[] | undefined {
  const value = record.done
  if (value === undefined || value === null) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('分析结果字段 done 无效')
  }
  return (value as string[])
    .map((item) => clipLine(item, STEP_MAX_LENGTH))
    .filter((item) => item !== '')
    .slice(0, MAX_DONE_ITEMS)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const REVIEW_REASON_MAX_LENGTH = 80

/** Optional on analyses written before the review field existed or while the trigger is off. */
function analysisReview(record: Record<string, unknown>): Analysis['review'] {
  const value = record.review
  if (value === undefined || value === null) {
    return undefined
  }
  const review = asRecord(value)
  if (!review || typeof review.suggested !== 'boolean') {
    throw new Error('分析结果字段 review 无效')
  }
  if (review.reason !== undefined && typeof review.reason !== 'string') {
    throw new Error('分析结果字段 review 无效')
  }
  return {
    suggested: review.suggested,
    reason:
      typeof review.reason === 'string'
        ? clipLine(review.reason, REVIEW_REASON_MAX_LENGTH)
        : ''
  }
}

/**
 * Per-turn step/digest the analyzer returns. Malformed entries are dropped one
 * by one so a bad item can't fail the whole analysis; unknown turnIds are
 * ignored later at write time.
 */
function analysisTurnDigests(
  record: Record<string, unknown>
): TurnDigest[] | undefined {
  const value = record.turnDigests
  if (value === undefined || value === null) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new Error('分析结果字段 turnDigests 无效')
  }
  const out: TurnDigest[] = []
  for (const item of value) {
    const entry = asRecord(item)
    if (!entry) {
      continue
    }
    const turnId = entry.turnId
    const step = entry.step
    const digest = entry.digest
    if (
      typeof turnId !== 'string' ||
      typeof step !== 'string' ||
      typeof digest !== 'string'
    ) {
      continue
    }
    const id = turnId.trim()
    if (id === '') {
      continue
    }
    out.push({
      turnId: id,
      step: clipLine(step, TURN_STEP_MAX_LENGTH),
      digest:
        digest.trim().length > TURN_DIGEST_MAX_LENGTH
          ? `${digest.trim().slice(0, TURN_DIGEST_MAX_LENGTH - 1)}…`
          : digest.trim()
    })
  }
  return out
}

function text(
  record: Record<string, unknown>,
  key: string,
  maxLength = MAX_ANALYSIS_TEXT_LENGTH
): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`分析结果字段 ${key} 无效`)
  }
  return value
}

function textList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]
  if (
    !Array.isArray(value) ||
    value.length > MAX_ANALYSIS_LIST_ITEMS ||
    value.some((item) => typeof item !== 'string' || item.length > MAX_ANALYSIS_TEXT_LENGTH)
  ) {
    throw new Error(`分析结果字段 ${key} 无效`)
  }
  return value
}

export function parseAnalysis(value: unknown): Analysis {
  const record = asRecord(value)
  if (!record) {
    throw new Error('分析结果不是对象')
  }
  const status = record.status
  if (
    typeof status !== 'string' ||
    !ANALYSIS_STATUSES.includes(
      status as (typeof ANALYSIS_STATUSES)[number]
    )
  ) {
    throw new Error('分析结果状态无效')
  }
  const confidence = record.confidence
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error('分析结果置信度无效')
  }
  if (typeof record.needsUserAttention !== 'boolean') {
    throw new Error('分析结果人工介入字段无效')
  }
  const speech = optionalLine(record, 'speech', SPEECH_MAX_LENGTH)
  const now = optionalLine(record, 'now', NOW_MAX_LENGTH)
  const done = analysisDone(record)
  const review = analysisReview(record)
  const turnDigests = analysisTurnDigests(record)
  return {
    title: analysisTitle(record),
    summary: text(record, 'summary', 2_000),
    ...(speech === undefined ? {} : { speech }),
    goal: text(record, 'goal'),
    status: status as Analysis['status'],
    progress: textList(record, 'progress'),
    completed: textList(record, 'completed'),
    nextSteps: textList(record, 'nextSteps'),
    blockers: textList(record, 'blockers'),
    needsUserAttention: record.needsUserAttention,
    confidence,
    ...(done === undefined ? {} : { done }),
    ...(now === undefined ? {} : { now }),
    ...(review === undefined ? {} : { review }),
    ...(turnDigests === undefined ? {} : { turnDigests })
  }
}

/** Finds complete JSON objects in logs or fenced markdown without trusting text around them. */
function parseJsonCandidates(value: string): unknown[] {
  const textValue = stripAnsi(value).trim()
  const candidates: unknown[] = []
  try {
    candidates.push(JSON.parse(textValue))
  } catch {
    // A number of CLIs prepend progress lines; the balanced scan below handles those.
  }

  for (let start = 0; start < textValue.length; start += 1) {
    if (textValue[start] !== '{' && textValue[start] !== '[') {
      continue
    }
    const end = findJsonEnd(textValue, start)
    if (end === -1) {
      continue
    }
    try {
      candidates.push(JSON.parse(textValue.slice(start, end + 1)))
    } catch {
      // Keep scanning; a malformed log fragment may contain a valid later object.
    }
    start = end
  }
  return candidates
}

function findJsonEnd(value: string, start: number): number {
  const stack: string[] = []
  let quote = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        quote = false
      }
      continue
    }
    if (character === '"') {
      quote = true
      continue
    }
    if (character === '{' || character === '[') {
      stack.push(character)
      continue
    }
    if (character !== '}' && character !== ']') {
      continue
    }
    const expected = character === '}' ? '{' : '['
    if (stack.pop() !== expected) {
      return -1
    }
    if (stack.length === 0) {
      return index
    }
  }
  return -1
}

function findAnalysis(value: unknown, depth = 0): Analysis | null {
  if (depth > 4) {
    return null
  }
  try {
    return parseAnalysis(value)
  } catch {
    // Envelopes from Claude/Pi put the final message under one of these keys.
  }
  if (typeof value === 'string') {
    for (const candidate of parseJsonCandidates(value)) {
      const analysis = findAnalysis(candidate, depth + 1)
      if (analysis) {
        return analysis
      }
    }
    return null
  }
  const record = asRecord(value)
  if (!record) {
    return null
  }
  for (const key of ['structured_output', 'structuredOutput', 'result', 'output', 'text']) {
    if (!(key in record)) {
      continue
    }
    const analysis = findAnalysis(record[key], depth + 1)
    if (analysis) {
      return analysis
    }
  }
  const message = asRecord(record.message)
  if (message) {
    const analysis = findAnalysis(message.content, depth + 1)
    if (analysis) {
      return analysis
    }
  }
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      const analysis = findAnalysis(item, depth + 1)
      if (analysis) {
        return analysis
      }
    }
  }
  return null
}

export function parseAnalysisOutput(stdout: string): Analysis {
  for (const candidate of parseJsonCandidates(stdout)) {
    const analysis = findAnalysis(candidate)
    if (analysis) {
      return analysis
    }
  }
  throw new Error('分析器未返回符合格式的 JSON 结果')
}
