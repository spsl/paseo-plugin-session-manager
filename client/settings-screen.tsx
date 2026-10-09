import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsGroup,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text } from "react-native";
import {
  getAnalyzerAgentOptions,
  getAnalyzerModelOptions,
  getDefaultAnalysisConfig,
  getThinkingLevelOptions,
  isAnalyzerAgent,
  normalizeAnalysisConfig,
  type AnalyzerAgent,
} from "../shared/analysis-config";
import { ANALYZER_SETTINGS, type AnalyzerSettings } from "../shared/settings";
import { testAnalyzerRpc } from "../shared/rpc";
import { PromptEditor } from "./prompt-editor";
import { errorText } from "./styles";

const SAVE_DEBOUNCE_MS = 600;

type NumberRange = { min: number; max: number };

/** A text input that commits (debounced, flushed on unmount) only valid, clamped integers. */
function NumberInput(props: {
  label: string;
  hint?: string;
  initialValue: number;
  range: NumberRange;
  disabled?: boolean;
  onCommit(value: number): void;
}) {
  const { range } = props;
  const latest = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(props.onCommit);
  commitRef.current = props.onCommit;
  const initialRef = useRef(props.initialValue);
  initialRef.current = props.initialValue;

  const flush = useCallback(
    function flush() {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const text = latest.current;
      latest.current = null;
      if (text === null) return;
      const parsed = Number.parseInt(text.trim(), 10);
      if (!Number.isFinite(parsed)) return;
      const clamped = Math.min(range.max, Math.max(range.min, parsed));
      if (clamped !== initialRef.current) commitRef.current(clamped);
    },
    [range.max, range.min],
  );
  useEffect(
    function flushOnUnmount() {
      return flush;
    },
    [flush],
  );

  return (
    <SettingsInput
      label={props.label}
      hint={props.hint ?? `范围 ${range.min}–${range.max}`}
      initialValue={String(props.initialValue)}
      disabled={props.disabled}
      onChangeText={function changed(text) {
        latest.current = text;
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
      }}
    />
  );
}

/** A text input that commits its trimmed text (debounced, flushed on unmount). */
function TextCommitInput(props: {
  label: string;
  hint?: string;
  placeholder?: string;
  initialValue: string;
  disabled?: boolean;
  onCommit(value: string): void;
}) {
  const latest = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(props.onCommit);
  commitRef.current = props.onCommit;
  const initialRef = useRef(props.initialValue);
  initialRef.current = props.initialValue;

  const flush = useCallback(function flush() {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const text = latest.current;
    latest.current = null;
    if (text === null) return;
    const trimmed = text.trim();
    if (trimmed !== initialRef.current) commitRef.current(trimmed);
  }, []);
  useEffect(
    function flushOnUnmount() {
      return flush;
    },
    [flush],
  );

  return (
    <SettingsInput
      label={props.label}
      {...(props.hint === undefined ? {} : { hint: props.hint })}
      {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
      initialValue={props.initialValue}
      disabled={props.disabled}
      onChangeText={function changed(text) {
        latest.current = text;
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
      }}
    />
  );
}

export function SessionManagerSettingsScreen(props: PluginSurfaceProps) {
  const { theme, layout } = props;
  const toast = useToast();
  const settings = useSettings(ANALYZER_SETTINGS);
  const runTest = useRpc(testAnalyzerRpc);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  // Bumped when the model select changes so the free-input remounts with the new value.
  const [modelEpoch, setModelEpoch] = useState(0);

  const save = useCallback(
    async function save(patch: Partial<AnalyzerSettings>): Promise<void> {
      if (settings.status !== "ready") return;
      const saved = await settings.save({ ...settings.values, ...patch }, settings.revision);
      if (!saved) {
        toast.error("设置已被其他设备修改，已重新加载");
        await settings.reload();
      }
    },
    [settings, toast],
  );

  const onTest = useCallback(
    async function onTest(): Promise<void> {
      setTesting(true);
      setTestResult(null);
      try {
        const result = await runTest({});
        setTestResult(
          result.ok
            ? {
                ok: true,
                text: `测试通过（${(result.durationMs / 1000).toFixed(1)} 秒）${result.title ? `：${result.title}` : ""}`,
              }
            : { ok: false, text: result.error ?? "测试失败" },
        );
      } catch (error) {
        setTestResult({ ok: false, text: errorText(error) });
      } finally {
        setTesting(false);
      }
    },
    [runTest],
  );

  const values = settings.status === "ready" ? settings.values : null;
  const disabled = values === null;
  const config = normalizeAnalysisConfig(
    values
      ? {
          agent: values.agent,
          model: values.model,
          thinkingLevel: values.thinkingLevel,
          systemPrompt: values.systemPrompt,
        }
      : undefined,
  );
  const modelOptions = getAnalyzerModelOptions(config.agent).map(function toOption(option) {
    return { label: option.label, value: option.id };
  });
  if (!modelOptions.some((option) => option.value === config.model)) {
    modelOptions.unshift({ label: `${config.model}（自定义）`, value: config.model });
  }
  const thinkingOptions = getThinkingLevelOptions(config.agent, config.model);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 16 }}
    >
      {settings.status === "loading" ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>正在加载设置…</Text>
      ) : null}
      {settings.status === "error" || settings.status === "invalid" ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>
          {`设置加载失败：${settings.error}`}
        </Text>
      ) : null}
      {settings.saveError ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{settings.saveError}</Text>
      ) : null}

      <SettingsGroup title="会话看板">
        <SettingsSection title="分析">
          <SettingsSwitch
            label="自动分析"
            hint="Agent 完成一轮后自动分析会话状态；关闭后仍可手动重新分析。"
            value={values?.enabled ?? true}
            disabled={disabled}
            onValueChange={function toggle(value) {
              void save({ enabled: value });
            }}
          />
          <SettingsSelect<AnalyzerAgent>
            label="分析器"
            hint="用本机已安装的 CLI 执行分析。"
            value={config.agent}
            options={getAnalyzerAgentOptions().map(function toOption(option) {
              return { label: option.label, value: option.id };
            })}
            disabled={disabled}
            onValueChange={function change(value) {
              if (!isAnalyzerAgent(value) || value === config.agent) return;
              const next = getDefaultAnalysisConfig(value);
              setModelEpoch((epoch) => epoch + 1);
              void save({
                agent: value,
                model: next.model,
                thinkingLevel: next.thinkingLevel ?? "",
              });
            }}
          />
          <SettingsSelect<string>
            label="模型"
            value={config.model}
            options={modelOptions}
            disabled={disabled}
            onValueChange={function change(value) {
              const options = getThinkingLevelOptions(config.agent, value);
              const keep = options.some((option) => option.id === config.thinkingLevel);
              const fallback = options.find((option) => option.id === "low") ?? options[0];
              setModelEpoch((epoch) => epoch + 1);
              void save({
                model: value,
                thinkingLevel: keep ? (config.thinkingLevel ?? "") : (fallback?.id ?? ""),
              });
            }}
          />
          <TextCommitInput
            key={`model-${config.agent}-${modelEpoch}`}
            label="自定义模型 ID"
            hint="列表之外的模型可以直接填写；留空则保持当前模型。"
            placeholder={config.model}
            initialValue=""
            disabled={disabled}
            onCommit={function commit(value) {
              if (value === "") return;
              void save({ model: value });
            }}
          />
          {thinkingOptions.length > 0 ? (
            <SettingsSelect<string>
              label="思考强度"
              value={config.thinkingLevel ?? thinkingOptions[0].id}
              options={thinkingOptions.map(function toOption(option) {
                return { label: option.label, value: option.id };
              })}
              disabled={disabled}
              onValueChange={function change(value) {
                void save({ thinkingLevel: value });
              }}
            />
          ) : null}
          <TextCommitInput
            label="可执行文件路径"
            hint="留空则从 PATH 中查找所选分析器。"
            placeholder="例如 /opt/homebrew/bin/codex"
            initialValue={values?.command ?? ""}
            disabled={disabled}
            onCommit={function commit(value) {
              void save({ command: value });
            }}
          />
          <SettingsSelect<string>
            label="并发数"
            value={String(values?.concurrency ?? 2)}
            options={["1", "2", "3", "4"].map(function toOption(value) {
              return { label: value, value };
            })}
            disabled={disabled}
            onValueChange={function change(value) {
              void save({ concurrency: Number.parseInt(value, 10) });
            }}
          />
          <NumberInput
            label="超时（秒）"
            initialValue={values?.timeoutSeconds ?? 120}
            range={{ min: 30, max: 600 }}
            disabled={disabled}
            onCommit={function commit(value) {
              void save({ timeoutSeconds: value });
            }}
          />
          <SettingsAction
            label="测试分析器"
            hint={testResult ? testResult.text : "用内置样例运行一次分析器，检查配置是否可用。"}
            error={testResult && !testResult.ok ? testResult.text : null}
            actionLabel={testing ? "测试中…" : "运行测试"}
            disabled={testing || disabled}
            onPress={function press() {
              void onTest();
            }}
          />
        </SettingsSection>

        <SettingsSection title="提示词">
          <PromptEditor
            label="自定义分析提示词"
            hint="留空使用内置提示词；这里只覆盖业务分析指令，安全、只读和 JSON 输出约束仍会保留。"
            value={values?.systemPrompt ?? ""}
            disabled={disabled}
            theme={theme}
            compact={layout.compact}
            onSave={function savePrompt(next) {
              void save({ systemPrompt: next });
            }}
          />
        </SettingsSection>

        <SettingsSection title="标题">
          <SettingsSwitch
            label="将生成的标题写回 Paseo"
            hint="默认关闭；不会覆盖你手动设置的名称。"
            value={values?.writeBackTitle ?? false}
            disabled={disabled}
            onValueChange={function toggle(value) {
              void save({ writeBackTitle: value });
            }}
          />
        </SettingsSection>

        <SettingsSection title="看板">
          <NumberInput
            label="启动时自动分析最近 N 个会话"
            hint="范围 0–50；其余会话显示“未分析”，可手动重新分析。"
            initialValue={values?.seedAnalyzeLimit ?? 10}
            range={{ min: 0, max: 50 }}
            disabled={disabled}
            onCommit={function commit(value) {
              void save({ seedAnalyzeLimit: value });
            }}
          />
          <NumberInput
            label="已关闭会话保留天数"
            initialValue={values?.closedRetentionDays ?? 7}
            range={{ min: 1, max: 90 }}
            disabled={disabled}
            onCommit={function commit(value) {
              void save({ closedRetentionDays: value });
            }}
          />
        </SettingsSection>
      </SettingsGroup>
    </ScrollView>
  );
}
