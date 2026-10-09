import { describe, expect, it } from 'vitest'
import {
  parseAnalysis,
  parseAnalysisOutput
} from './output'
import type { Analysis } from '../../shared/types'

const analysis: Analysis = {
  title: '完成需求实现',
  summary: '已经完成需求。',
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

  it('accepts legacy output without a title by deriving one from the goal', () => {
    const { title: _title, ...legacy } = analysis
    expect(parseAnalysis(legacy)).toMatchObject({ title: '完成需求' })
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
