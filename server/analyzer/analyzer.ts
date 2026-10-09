import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisConfig } from "../../shared/analysis-config";
import type { Analysis } from "../../shared/types";
import { buildAnalyzerEnv, resolveAnalyzerBinary, spawnBounded } from "../cli";
import { buildAnalyzerInvocation, type AnalyzerInvocation } from "./invocation";
import { parseAnalysis, parseAnalysisOutput } from "./output";
import { buildAnalysisPrompt, buildAnalysisSchema, type AnalyzerInput } from "./prompt";

export const ANALYZER_OUTPUT_LIMIT = 512 * 1024;
export const DEFAULT_ANALYZER_TIMEOUT_MS = 120_000;

export type AnalyzerRunConfig = AnalysisConfig & {
  /** Executable override from settings; empty means resolve from PATH. */
  command?: string;
  timeoutMs?: number;
};

/** An interface so the service can be tested with a fake. */
export type Analyzer = {
  analyze(input: AnalyzerInput, config: AnalyzerRunConfig): Promise<Analysis>;
};

export function conciseFailure(result: {
  timedOut: boolean;
  code: number | null;
  stderr: string;
}): string {
  if (result.timedOut) {
    return "分析超时";
  }
  const detail = result.stderr.trim().split("\n").at(-1)?.slice(0, 280);
  return detail || `分析器异常退出（code=${String(result.code)}）`;
}

export async function readInvocationAnalysis(
  invocation: AnalyzerInvocation,
  stdout: string,
): Promise<Analysis> {
  if (invocation.outputPath) {
    return parseAnalysis(JSON.parse(await readFile(invocation.outputPath, "utf8")));
  }
  return parseAnalysisOutput(stdout);
}

/** Runs a separate read-only CLI analysis process in a temp directory. */
export class CliAnalyzer implements Analyzer {
  async analyze(input: AnalyzerInput, config: AnalyzerRunConfig): Promise<Analysis> {
    const command = await resolveAnalyzerBinary(config.agent, config.command);
    const directory = await mkdtemp(join(tmpdir(), "session-manager-analyzer-"));
    const schemaPath = join(directory, "analysis-schema.json");
    const outputPath = join(directory, "analysis-result.json");
    try {
      const schema = buildAnalysisSchema();
      await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
      const invocation = buildAnalyzerInvocation({
        config,
        command,
        paths: { schemaPath, outputPath },
        schema,
      });
      const result = await spawnBounded({
        program: invocation.program,
        args: invocation.args,
        cwd: directory,
        input: buildAnalysisPrompt(input, schema, config.systemPrompt),
        env: await buildAnalyzerEnv(invocation.program),
        timeoutMs: config.timeoutMs ?? DEFAULT_ANALYZER_TIMEOUT_MS,
        outputLimit: ANALYZER_OUTPUT_LIMIT,
      });
      if (result.timedOut || result.code !== 0) {
        throw new Error(conciseFailure(result));
      }
      if (!invocation.outputPath && result.truncated) {
        throw new Error("分析器输出过长");
      }
      return await readInvocationAnalysis(invocation, result.stdout);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
