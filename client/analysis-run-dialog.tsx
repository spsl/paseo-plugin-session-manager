/**
 * 分析记录 detail dialog: one analyzer call's metadata plus its full result,
 * fetched on open. Sessions analyzed before calls were logged show their
 * stored analysis without call metadata.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { getAnalyzerAgentOptions } from "../shared/analysis-config";
import {
  analysisRunOutcomeLabel,
  analysisStatusLabel,
  confidenceLabel,
  formatDuration,
} from "../shared/presentation";
import { analysisRunRpc } from "../shared/rpc";
import type { Analysis, AnalysisRun, AnalysisRunSummary } from "../shared/types";
import { errorText, formatDateTime } from "./styles";

export type AnalysisRunTarget =
  | { kind: "run"; run: AnalysisRunSummary }
  | { kind: "legacy"; analysis: Analysis };

type Props = {
  sessionId: string;
  /** null keeps the dialog closed. */
  target: AnalysisRunTarget | null;
  theme: PluginTheme;
  onClose(): void;
};

export function AnalysisRunDialog(props: Props) {
  const { target, theme } = props;
  return (
    <Modal
      title="分析记录"
      open={target !== null}
      onOpenChange={function change(open) {
        if (!open) props.onClose();
      }}
    >
      <Modal.Content contentContainerStyle={{ padding: 16, gap: 14 }}>
        {target === null ? null : target.kind === "run" ? (
          <RunBody key={target.run.id} sessionId={props.sessionId} run={target.run} theme={theme} />
        ) : (
          <>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              记录功能上线前的分析，没有调用信息。
            </Text>
            <AnalysisBody analysis={target.analysis} theme={theme} />
          </>
        )}
      </Modal.Content>
    </Modal>
  );
}

function agentLabel(agent: string): string {
  const match = getAnalyzerAgentOptions().find(function byId(option) {
    return option.id === agent;
  });
  return match ? match.label : agent || "未知";
}

function RunBody(props: { sessionId: string; run: AnalysisRunSummary; theme: PluginTheme }) {
  const { sessionId, run, theme } = props;
  const { colors } = theme;
  const getRun = useRpc(analysisRunRpc);
  // A logged call never changes, so one fetch per opened record is enough.
  const query = useQuery({
    queryKey: ["session-manager", "analysis-run", sessionId, run.id],
    queryFn: async function load() {
      return getRun({ sessionId, runId: run.id });
    },
    staleTime: Infinity,
    retry: false,
  });
  const full: AnalysisRun | null = query.data?.run ?? null;
  const outcomeTone =
    run.outcome === "failed"
      ? colors.statusDanger
      : run.outcome === "applied"
        ? colors.foreground
        : colors.foregroundMuted;

  let result;
  if (query.isPending) {
    result = <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>正在加载分析结果…</Text>;
  } else if (query.isError) {
    result = (
      <Text style={{ color: colors.statusDanger, fontSize: 12 }}>
        {`加载失败：${errorText(query.error)}`}
      </Text>
    );
  } else if (full === null) {
    result = (
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>这条记录已被清理。</Text>
    );
  } else if (full.analysis !== null) {
    result = <AnalysisBody analysis={full.analysis} theme={theme} />;
  } else {
    result = null;
  }

  return (
    <>
      <View style={{ gap: 4 }}>
        <MetaRow theme={theme} label="时间" value={formatDateTime(run.startedAt)} />
        <MetaRow theme={theme} label="耗时" value={formatDuration(run.durationMs)} />
        <MetaRow
          theme={theme}
          label="分析器"
          value={`${agentLabel(run.agent)}${run.model ? ` / ${run.model}` : ""}`}
        />
        <MetaRow
          theme={theme}
          label="结果"
          value={`${analysisRunOutcomeLabel(run.outcome)}${run.reanalysis ? " · 重新分析" : ""}`}
          tone={outcomeTone}
        />
        {full !== null ? (
          <MetaRow
            theme={theme}
            label="输入"
            value={`${full.inputChars} 字 · 新轮次 ${full.newTurns} · 历史摘要 ${full.digestCount} 条`}
          />
        ) : null}
      </View>
      <Block theme={theme} title="用户输入">
        <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>
          {run.userInput ?? "无新的用户消息"}
        </Text>
      </Block>
      {run.error !== null ? (
        <Block theme={theme} title="失败原因">
          <Text selectable style={{ color: colors.statusDanger, fontSize: 13, lineHeight: 19 }}>
            {run.error}
          </Text>
        </Block>
      ) : null}
      {result}
    </>
  );
}

function AnalysisBody(props: { analysis: Analysis; theme: PluginTheme }) {
  const { analysis, theme } = props;
  const { colors } = theme;
  const verdict = `${analysisStatusLabel(analysis.status)} · 置信度 ${confidenceLabel(analysis.confidence)}${analysis.needsUserAttention ? " · 需要用户关注" : ""}`;
  return (
    <>
      <Block theme={theme} title="判断">
        <Paragraph theme={theme} text={verdict} />
      </Block>
      <Block theme={theme} title="标题">
        <Paragraph theme={theme} text={analysis.title || "暂无"} />
      </Block>
      {analysis.now ? (
        <Block theme={theme} title="现在">
          <Paragraph theme={theme} text={analysis.now} />
        </Block>
      ) : null}
      <Block theme={theme} title="当前判断">
        <Paragraph theme={theme} text={analysis.summary || "暂无"} />
      </Block>
      <Block theme={theme} title="当前目标">
        <Paragraph theme={theme} text={analysis.goal || "暂无"} />
      </Block>
      {analysis.done !== undefined ? (
        <Items theme={theme} title="本次完成" items={analysis.done} empty="无" />
      ) : null}
      <Items theme={theme} title="进展" items={analysis.progress} empty="暂无明确进展" />
      <Items theme={theme} title="已完成" items={analysis.completed} empty="尚无完成证据" />
      <Items theme={theme} title="下一步" items={analysis.nextSteps} empty="暂无" />
      <Items theme={theme} title="阻塞原因" items={analysis.blockers} empty="未发现阻塞项" />
      {analysis.review ? (
        <Block theme={theme} title="审查建议">
          <Paragraph
            theme={theme}
            text={`${analysis.review.suggested ? "建议审查" : "暂不需要"}${analysis.review.reason ? `：${analysis.review.reason}` : ""}`}
          />
        </Block>
      ) : null}
      {analysis.turnDigests && analysis.turnDigests.length > 0 ? (
        <TurnDigests theme={theme} digests={analysis.turnDigests} />
      ) : null}
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>以上为该次调用的模型原始输出。</Text>
    </>
  );
}

/** Per-turn digests can run to thousands of characters, so they start folded. */
function TurnDigests(props: { theme: PluginTheme; digests: NonNullable<Analysis["turnDigests"]> }) {
  const { theme, digests } = props;
  const { colors } = theme;
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        onPress={function toggle() {
          setOpen(!open);
        }}
        style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
          {`轮次摘要（${digests.length}）`}
        </Text>
      </Pressable>
      {open
        ? digests.map(function renderDigest(entry) {
            return (
              <View key={entry.turnId} style={{ gap: 2, paddingLeft: 20 }}>
                <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>
                  {entry.step || "未命名步骤"}
                </Text>
                <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
                  {entry.digest || "回复较短，保存原文"}
                </Text>
              </View>
            );
          })
        : null}
    </View>
  );
}

function MetaRow(props: { theme: PluginTheme; label: string; value: string; tone?: string }) {
  const { colors } = props.theme;
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Text style={{ width: 56, color: colors.foregroundMuted, fontSize: 12 }}>{props.label}</Text>
      <Text selectable style={{ flex: 1, color: props.tone ?? colors.foreground, fontSize: 12 }}>
        {props.value}
      </Text>
    </View>
  );
}

function Block(props: { theme: PluginTheme; title: string; children: ReactNode }) {
  const { colors } = props.theme;
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>{props.title}</Text>
      {props.children}
    </View>
  );
}

function Paragraph(props: { theme: PluginTheme; text: string }) {
  return (
    <Text selectable style={{ color: props.theme.colors.foreground, fontSize: 13, lineHeight: 19 }}>
      {props.text}
    </Text>
  );
}

function Items(props: { theme: PluginTheme; title: string; items: readonly string[]; empty: string }) {
  const { colors } = props.theme;
  return (
    <Block theme={props.theme} title={props.title}>
      {props.items.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{props.empty}</Text>
      ) : (
        props.items.map(function renderItem(item, index) {
          return (
            <Text key={index} selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>
              {`• ${item}`}
            </Text>
          );
        })
      )}
    </Block>
  );
}
