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
import {
  magpieModelsRpc,
  piModelsRpc,
  speechVoicesRpc,
  testAnalyzerRpc,
} from "../shared/rpc";
import {
  SPEECH_SETTINGS,
  RATE_OPTIONS,
  type SpeechEngine,
  type SpeechSettings,
  type SpeechVoice,
} from "../shared/speech";
import { getAnnouncer, isMutedHere, mirrorSettings, setMutedHere } from "./announcer";
import { ModelPicker } from "./model-picker";
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

const TEST_SENTENCE = "会话看板：这是一条测试语音，之后的播报会像这样。";

/** Agents whose model catalog is discovered at runtime rather than seeded. */
const LIVE_CATALOG_AGENTS = ["pi", "magpie"] as const;
type LiveCatalogAgent = (typeof LIVE_CATALOG_AGENTS)[number];

function isLiveCatalogAgent(agent: AnalyzerAgent): agent is LiveCatalogAgent {
  return (LIVE_CATALOG_AGENTS as readonly string[]).includes(agent);
}

type LiveCatalogState = {
  options: { label: string; value: string }[];
  thinking: Record<string, boolean>;
  problem: string | null;
  /** True once a fetch succeeded; failures stay false so they can be retried. */
  loaded: boolean;
};

function emptyLiveCatalog(): LiveCatalogState {
  return { options: [], thinking: {}, problem: null, loaded: false };
}

/**
 * Both live sources report whether a model does reasoning at all; when it does
 * not, no effort flag is offered (pi would reject `--thinking`). Unknown ids
 * assume yes so a hand-typed model keeps the generic options.
 */
function supportsThinkingFor(
  agent: AnalyzerAgent,
  model: string,
  thinking: Record<string, boolean>,
): boolean {
  if (!isLiveCatalogAgent(agent)) {
    return true;
  }
  return thinking[model] !== false;
}

function SpeechSection(props: { disabled?: boolean }) {
  const toast = useToast();
  const settings = useSettings(SPEECH_SETTINGS);
  const fetchVoices = useRpc(speechVoicesRpc);
  const [voices, setVoices] = useState<{ available: boolean; voices: SpeechVoice[] } | null>(null);
  const [testing, setTesting] = useState(false);
  const [muted, setMuted] = useState(isMutedHere());

  useEffect(
    function loadVoices() {
      let cancelled = false;
      fetchVoices({})
        .then(function done(result) {
          if (!cancelled) setVoices(result);
        })
        .catch(function failed() {
          if (!cancelled) setVoices({ available: false, voices: [] });
        });
      return function cancel() {
        cancelled = true;
      };
    },
    [fetchVoices],
  );

  useEffect(
    function mirror() {
      if (settings.status === "ready") mirrorSettings(settings.values);
    },
    [settings],
  );

  const save = useCallback(
    async function save(patch: Partial<SpeechSettings>): Promise<void> {
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
      const announcer = getAnnouncer();
      if (announcer === null) return;
      setTesting(true);
      try {
        // Forced: this is where the voice is chosen, and in a browser it is the
        // press that hands the page its audio permission.
        await announcer.speakText(TEST_SENTENCE, { force: true });
      } catch (error) {
        toast.error(errorText(error));
      } finally {
        setTesting(false);
      }
    },
    [toast],
  );

  const values = settings.status === "ready" ? settings.values : null;
  const disabled = values === null || props.disabled === true;
  const sayAvailable = voices?.available === true;
  const voiceOptions: { label: string; value: string }[] = [
    { label: "自动（优先中文婷婷，否则系统默认）", value: "" },
  ];
  for (const voice of voices?.voices ?? []) {
    if (voice.lang.toLowerCase().indexOf("zh") === 0) {
      voiceOptions.push({ label: `${voice.name} · ${voice.lang}`, value: voice.name });
    }
  }
  const currentVoice = values?.sayVoice ?? "";
  if (currentVoice !== "" && !voiceOptions.some((option) => option.value === currentVoice)) {
    voiceOptions.push({ label: `${currentVoice}（当前）`, value: currentVoice });
  }

  return (
    <SettingsGroup title="语音播报">
      {settings.status === "error" || settings.status === "invalid" ? (
        <Text style={{ fontSize: 13 }}>{`语音设置加载失败：${settings.error}`}</Text>
      ) : null}
      <SettingsSection title="总开关">
        <SettingsSwitch
          label="语音播报"
          hint="每轮分析完成、需要授权或回答时，用一句话播报。"
          value={values?.enabled ?? true}
          disabled={disabled}
          onValueChange={function toggle(value) {
            void save({ enabled: value });
          }}
        />
        <SettingsSwitch
          label="桌面端播报"
          value={values?.speakOnDesktop ?? true}
          disabled={disabled}
          onValueChange={function toggle(value) {
            void save({ speakOnDesktop: value });
          }}
        />
        <SettingsSwitch
          label="浏览器播报"
          hint="浏览器要求先有一次用户操作：打开页面后点一次“测试语音”即可解锁。"
          value={values?.speakInBrowser ?? true}
          disabled={disabled}
          onValueChange={function toggle(value) {
            void save({ speakInBrowser: value });
          }}
        />
        <SettingsSwitch
          label="手机震动提醒"
          hint="手机端无法由插件朗读，仅在无法播放音频时震动提醒。"
          value={values?.vibrateOnMobile ?? false}
          disabled={disabled}
          onValueChange={function toggle(value) {
            void save({ vibrateOnMobile: value });
          }}
        />
        <SettingsSwitch
          label="本机静音"
          hint="只对这台设备生效，重启应用后恢复。"
          value={muted}
          onValueChange={function toggle(value) {
            setMutedHere(value);
            setMuted(value);
          }}
        />
      </SettingsSection>
      <SettingsSection title="声音">
        <SettingsSelect<SpeechEngine>
          label="声音来源"
          hint="守护进程所在的 Mac 用 say 合成（更自然）；不可用时回退到本机浏览器语音。"
          value={values?.engine ?? "say"}
          options={[
            {
              label: voices !== null && !sayAvailable ? "守护进程 Mac（say，不可用）" : "守护进程 Mac（say）",
              value: "say",
            },
            { label: "本机浏览器", value: "web" },
          ]}
          disabled={disabled}
          onValueChange={function change(value) {
            void save({ engine: value });
          }}
        />
        <SettingsSelect<string>
          label="声音"
          value={currentVoice}
          options={voiceOptions}
          disabled={disabled || !sayAvailable}
          onValueChange={function change(value) {
            void save({ sayVoice: value });
          }}
        />
        <SettingsSelect<string>
          label="语速"
          value={values?.rate ?? "1"}
          options={RATE_OPTIONS.map(function toOption(rate) {
            return { label: `${rate}×`, value: rate };
          })}
          disabled={disabled}
          onValueChange={function change(value) {
            const match = RATE_OPTIONS.find(function same(rate) {
              return rate === value;
            });
            if (match !== undefined) void save({ rate: match });
          }}
        />
        <SettingsAction
          label="测试语音"
          hint="按所选声音朗读一句测试语音；也会解锁浏览器的音频权限。"
          actionLabel={testing ? "播放中…" : "测试语音"}
          disabled={testing}
          onPress={function press() {
            void onTest();
          }}
        />
      </SettingsSection>
      <SettingsSection title="播报哪些事件">
        <SettingsSwitch
          label="完成"
          value={values?.announceFinished ?? true}
          disabled={disabled}
          onValueChange={function toggle(value) {
            void save({ announceFinished: value });
          }}
        />
        <SettingsSwitch
          label="需要处理（含提问）"
          value={values?.announceWaiting ?? true}
          disabled={disabled}
          onValueChange={function toggle(value) {
            void save({ announceWaiting: value });
          }}
        />
        <SettingsSwitch
          label="等待授权"
          value={values?.announcePermission ?? true}
          disabled={disabled}
          onValueChange={function toggle(value) {
            void save({ announcePermission: value });
          }}
        />
        <SettingsSwitch
          label="失败"
          value={values?.announceError ?? true}
          disabled={disabled}
          onValueChange={function toggle(value) {
            void save({ announceError: value });
          }}
        />
        <SettingsSwitch
          label="子 Agent 也播报"
          hint="默认关闭：由其他 Agent 启动的子 Agent 只显示卡片，不朗读（父 Agent 会汇报结果）。"
          value={values?.announceSubagents ?? false}
          disabled={disabled}
          onValueChange={function toggle(value) {
            void save({ announceSubagents: value });
          }}
        />
      </SettingsSection>
    </SettingsGroup>
  );
}

export function SessionManagerSettingsScreen(props: PluginSurfaceProps) {
  const { theme, layout } = props;
  const toast = useToast();
  const settings = useSettings(ANALYZER_SETTINGS);
  const runTest = useRpc(testAnalyzerRpc);
  const loadPiModels = useRpc(piModelsRpc);
  const loadMagpieModels = useRpc(magpieModelsRpc);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  /**
   * Catalog for agents whose models can only be discovered at runtime, cached
   * per agent. A failed fetch is not latched, so switching back retries.
   */
  const [liveCatalog, setLiveCatalog] = useState<Record<LiveCatalogAgent, LiveCatalogState>>({
    pi: emptyLiveCatalog(),
    magpie: emptyLiveCatalog(),
  });
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
  // Only a live agent's own catalog replaces the seeded options.
  const catalog = isLiveCatalogAgent(config.agent)
    ? liveCatalog[config.agent]
    : emptyLiveCatalog();
  // Pi's catalog comes from its CLI, Magpie's from the local proxy; the shared
  // seed still serves Codex and Claude.
  if (catalog.options.length > 0) {
    modelOptions.length = 0;
    modelOptions.push(...catalog.options);
  }
  if (!modelOptions.some((option) => option.value === config.model)) {
    modelOptions.unshift({ label: `${config.model}（自定义）`, value: config.model });
  }
  const thinkingOptions = supportsThinkingFor(config.agent, config.model, catalog.thinking)
    ? getThinkingLevelOptions(config.agent, config.model)
    : [];
  const modelHint =
    isLiveCatalogAgent(config.agent)
      ? catalog.problem === null
        ? config.agent === "magpie"
          ? "来自本机 Magpie 代理的模型目录。"
          : "来自本机 pi CLI 的模型目录。"
        : `${catalog.problem}；仍可在下方填写模型 ID。`
      : "列表之外的模型可以在下方填写模型 ID。";

  // Neither Pi nor Magpie has a fixed catalog: the ids live in the user's own
  // CLI config and proxy, so the daemon is asked once per agent switch. The
  // in-flight set lives outside state so a re-render cannot drop a fetch.
  const requestedRef = useRef<Set<LiveCatalogAgent>>(new Set());
  // Unmount-only cancellation: cancelling on every effect re-run would drop a
  // result that lands while the effect's own state update re-runs it.
  const mountedRef = useRef(true);
  useEffect(
    function loadLiveModelCatalog() {
      if (!isLiveCatalogAgent(config.agent) || catalog.loaded) {
        return;
      }
      // Bound once so the closure below indexes a concrete agent key.
      const agent: LiveCatalogAgent = config.agent;
      if (requestedRef.current.has(agent)) {
        return;
      }
      requestedRef.current.add(agent);
      // Marked loading only for this agent; a failure leaves it retryable.
      setLiveCatalog((state) => ({ ...state, [agent]: { ...state[agent], loaded: true } }));
      const request = agent === "magpie" ? loadMagpieModels({}) : loadPiModels({});
      request
        .then(function done(result) {
          if (!mountedRef.current) return;
          requestedRef.current.delete(agent);
          const thinking: Record<string, boolean> = {};
          const options = result.models.map(function toOption(model) {
            thinking[model.id] = model.thinking;
            // The id is already provider-qualified for Pi; repeating the
            // provider only pushed the useful part out of the row.
            return { label: model.label, value: model.id };
          });
          setLiveCatalog((state) => ({
            ...state,
            [agent]: { options, thinking, problem: result.problem, loaded: true },
          }));
        })
        .catch(function failed() {
          if (!mountedRef.current) return;
          requestedRef.current.delete(agent);
          const what = agent === "magpie" ? "Magpie" : "pi";
          setLiveCatalog((state) => ({
            ...state,
            [agent]: {
              ...emptyLiveCatalog(),
              problem: `无法读取${what}模型列表`,
              loaded: false,
            },
          }));
        });
      // No cleanup: the request must survive the state update it triggers.
      return;
    },
    // Only the agent matters. `catalog.loaded` is read but not depended on, so
    // the effect cannot re-run because of its own state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.agent, loadMagpieModels, loadPiModels],
  );
  useEffect(
    function trackMounted() {
      mountedRef.current = true;
      return function markUnmounted() {
        mountedRef.current = false;
      };
    },
    [],
  );

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
              // A loaded live catalog replaces the seed, which would otherwise
              // hand the choice back to a CLI default the user never picked.
              const model =
                isLiveCatalogAgent(value) && liveCatalog[value].options.length > 0
                  ? (liveCatalog[value].options[0]?.value ?? next.model)
                  : next.model;
              const options = supportsThinkingFor(
                value,
                model,
                isLiveCatalogAgent(value) ? liveCatalog[value].thinking : {},
              )
                ? getThinkingLevelOptions(value, model)
                : [];
              void save({
                agent: value,
                model,
                thinkingLevel: options[0]?.id ?? "",
              });
            }}
          />
          {catalog.options.length > 0 ? (
            <ModelPicker
              label="模型"
              hint={modelHint}
              value={config.model}
              options={catalog.options}
              disabled={disabled}
              theme={theme}
              compact={layout.compact}
              onSelect={function change(value) {
                // A model without reasoning support must not keep an effort.
                const options = supportsThinkingFor(config.agent, value, catalog.thinking)
                  ? []
                  : getThinkingLevelOptions(config.agent, value);
                const keep = options.some((option) => option.id === config.thinkingLevel);
                const fallback = options.find((option) => option.id === "low") ?? options[0];
                setModelEpoch((epoch) => epoch + 1);
                void save({
                  model: value,
                  thinkingLevel: keep ? (config.thinkingLevel ?? "") : (fallback?.id ?? ""),
                });
              }}
            />
          ) : (
            <SettingsSelect<string>
              label="模型"
              value={config.model}
              options={modelOptions}
              disabled={disabled}
              onValueChange={function change(value) {
                // A model without reasoning support must not keep an effort.
                const options = supportsThinkingFor(config.agent, value, catalog.thinking)
                  ? []
                  : getThinkingLevelOptions(config.agent, value);
                const keep = options.some((option) => option.id === config.thinkingLevel);
                const fallback = options.find((option) => option.id === "low") ?? options[0];
                setModelEpoch((epoch) => epoch + 1);
                void save({
                  model: value,
                  thinkingLevel: keep ? (config.thinkingLevel ?? "") : (fallback?.id ?? ""),
                });
              }}
            />
          )}
          <TextCommitInput
            key={`model-${config.agent}-${modelEpoch}`}
            label="自定义模型 ID"
            hint={`${modelHint}留空则保持当前模型。`}
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
          {config.agent === "magpie" ? (
            <>
              <TextCommitInput
                label="Magpie 地址"
                hint="本机 Magpie 代理的 OpenAI 兼容地址；留空使用默认的 http://127.0.0.1:3425/v1。"
                placeholder="http://127.0.0.1:3425/v1"
                initialValue={values?.magpieBaseUrl ?? ""}
                disabled={disabled}
                onCommit={function commit(value) {
                  void save({ magpieBaseUrl: value });
                }}
              />
              <TextCommitInput
                label="Magpie API Key"
                hint="本机代理通常不需要；留空即可。"
                placeholder="sk-..."
                initialValue={values?.magpieApiKey ?? ""}
                disabled={disabled}
                onCommit={function commit(value) {
                  void save({ magpieApiKey: value });
                }}
              />
            </>
          ) : (
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
          )}
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
          <TextCommitInput
            label="排除的 Agent 标签"
            hint="带这些标签键的 Agent（通常是其他插件创建的辅助 Agent）不显示也不分析；多个用逗号分隔，可写 key 或 key=value。默认 herald.role"
            placeholder="herald.role"
            initialValue={values?.excludedLabelKeys ?? "herald.role"}
            disabled={disabled}
            onCommit={function commit(value) {
              void save({ excludedLabelKeys: value });
            }}
          />
          <NumberInput
            label="看板列宽（%）"
            hint="相对于五列铺满屏幕时的宽度，范围 30–500，默认 90；每列最窄 200px，超过 100 可横向滚动。"
            initialValue={values?.columnWidthPercent ?? 90}
            range={{ min: 30, max: 500 }}
            disabled={disabled}
            onCommit={function commit(value) {
              void save({ columnWidthPercent: value });
            }}
          />
        </SettingsSection>
      </SettingsGroup>
      <SpeechSection />
    </ScrollView>
  );
}
