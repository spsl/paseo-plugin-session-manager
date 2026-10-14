import { describe, expect, it } from 'vitest'
import {
  parseAnalysis,
  parseAnalysisOutput
} from './output'
import {
  MAX_DONE_ITEMS,
  NOW_MAX_LENGTH,
  SPEECH_MAX_LENGTH,
  STEP_MAX_LENGTH,
  speechOf,
  type Analysis
} from '../../shared/types'

const analysis: Analysis = {
  title: '完成需求实现',
  summary: '已经完成需求。',
  speech: '完成需求实现：功能已完成并通过验证，无需处理。',
  goal: '完成需求',
  status: 'completed',
  progress: ['已实现'],
  completed: ['已验证'],
  nextSteps: [],
  blockers: [],
  needsUserAttention: false,
  confidence: 0.95
}

describe('analyzer output', () => {
  it('validates a direct structured result', () => {
    expect(parseAnalysisOutput(JSON.stringify(analysis))).toEqual(analysis)
  })

  it('unwraps Claude-style JSON envelopes and nested result text', () => {
    expect(
      parseAnalysisOutput(
        JSON.stringify({
          type: 'result',
          result: JSON.stringify(analysis)
        })
      )
    ).toEqual(analysis)
  })

  it('finds fenced JSON after logs and ANSI styling', () => {
    const output = [
      '\u001b[2mstarting analysis\u001b[0m',
      '```json',
      JSON.stringify(analysis),
      '```'
    ].join('\n')
    expect(parseAnalysisOutput(output)).toEqual(analysis)
  })

  it('rejects malformed or schema-invalid output', () => {
    expect(() => parseAnalysisOutput('分析失败，没有 JSON')).toThrow(/JSON/)
    expect(() => parseAnalysis({ ...analysis, confidence: 2 })).toThrow(/置信度/)
    expect(() =>
      parseAnalysis({ ...analysis, progress: ['x'.repeat(4_001)] })
    ).toThrow(/progress/)
  })

  it('keeps done and now short and treats them as optional', () => {
    const parsed = parseAnalysis({
      ...analysis,
      done: ['  完成 A  ', '', 'x'.repeat(STEP_MAX_LENGTH + 5), 'B', 'C'],
      now: 'y'.repeat(NOW_MAX_LENGTH + 5)
    })
    expect(parsed.done).toHaveLength(MAX_DONE_ITEMS)
    expect(parsed.done?.[0]).toBe('完成 A')
    expect(parsed.done?.[1]).toHaveLength(STEP_MAX_LENGTH)
    expect(parsed.done?.[1].endsWith('…')).toBe(true)
    expect(parsed.now).toHaveLength(NOW_MAX_LENGTH)
    expect(parseAnalysis(analysis)).not.toHaveProperty('done')
    expect(parseAnalysis(analysis)).not.toHaveProperty('now')
    expect(() => parseAnalysis({ ...analysis, done: [1] })).toThrow(/done/)
    expect(() => parseAnalysis({ ...analysis, now: 1 })).toThrow(/now/)
  })

  it('accepts legacy output without a title by deriving one from the goal', () => {
    const { title: _title, ...legacy } = analysis
    expect(parseAnalysis(legacy)).toMatchObject({ title: '完成需求' })
  })

  it('keeps speech when present and leaves it absent on older output', () => {
    expect(parseAnalysis(analysis).speech).toBe(analysis.speech)
    const { speech: _speech, ...older } = analysis
    const parsed = parseAnalysis(older)
    expect(parsed.speech).toBeUndefined()
    expect(speechOf(parsed)).toBe('已经完成需求。')
  })

  it('normalizes and truncates overlong speech, rejects non-string speech', () => {
    const long = parseAnalysis({ ...analysis, speech: `甲\n${'乙'.repeat(200)}` })
    expect(long.speech).toHaveLength(SPEECH_MAX_LENGTH)
    expect(long.speech?.endsWith('…')).toBe(true)
    expect(long.speech).not.toMatch(/\n/)
    expect(() => parseAnalysis({ ...analysis, speech: 42 })).toThrow(/speech/)
    expect(parseAnalysis({ ...analysis, speech: '   ' }).speech).toBeUndefined()
  })

  it('rejects multiline or overlong generated titles', () => {
    expect(() => parseAnalysis({ ...analysis, title: '第一行\n第二行' })).toThrow(
      /title/
    )
    expect(() => parseAnalysis({ ...analysis, title: 'x'.repeat(49) })).toThrow(
      /title/
    )
  })
})
