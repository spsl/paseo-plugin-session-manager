# SDK notes (@getpaseo/plugin 0.11.1) for server/client stages

## Hard rules
- Runtime code must NOT import `@getpaseo/client` or `@getpaseo/protocol` (even `import type`): installs run `--omit=dev` and the daemon fails the install when a reachable import is missing. Derive types from `@getpaseo/plugin/server` or `/client` (herald `server/host-types.ts` pattern):
  - `type PaseoApi = PluginHandlerContext["paseo"]`
  - `type AgentTimelineItem = PluginLifecycleEvents["agent.turn_ended"]["timeline"][number]`
  - `type AgentPermissionRequest = PluginLifecycleEvents["agent.permission_requested"]["request"]`
  - Entry/snapshot types: `Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]`; timeline payload: `Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>`.
- Root holds only index.server.ts / index.client.tsx; code in shared/ server/ client/; no client<->server imports; client has no `node:*`.
- Hermes (client-reachable incl. shared/): no async arrow functions (use `async function`), avoid closures created inside `for...of` bodies.
- `@getpaseo/plugin` root exports only: `defineRpc`, `defineSettings`, `settingsRpc`, `defineAttachmentSource`, types (`PluginTheme`, `PluginAgentSnapshot`, `PluginWorkspaceSnapshot`, `PluginCleanup`, `RpcInput/RpcOutput`...). Subpaths: `/server`, `/client`, `/client/ui`, `/client/react-native`.

## defineRpc / defineSettings
```ts
defineRpc({ name: string, input: ZodType, output: ZodType }): PluginRpcContract
defineSettings({ id, scope: "host", version: number, schema, migrate? }): SettingsDefinition
```
Host RPC names are plain strings (we use `session-manager.*`). Zod 4. `RpcInput<C>` = zod *output* of input schema; `RpcOutput<C>` = zod *input* of output schema.

## Server (`@getpaseo/plugin/server`)
- `default export function contribute(server: PluginServerContext): PluginCleanup` (cleanup may be async).
- `PluginServerContext extends PluginLifecycleRegistration`:
  - `registerSettings(def): PluginSettings<Schema>` -> `{ read(): Promise<PluginSettingsState>; subscribe(listener): PluginCleanup }`
  - `PluginSettingsState = { status:"ready"; revision:string; values: Output } | { status:"invalid"; revision:string; error:string }` (check `status === "ready"` before using `values`).
  - `handle(contract, (input, ctx: PluginHandlerContext) => output | Promise<output>)`
  - `registerProvider`, `registerUsageSource` (unused).
- `PluginHandlerContext = { paseo: PaseoApi }`. `PluginServerContext` does NOT expose `paseo` itself: it is only available in handler ctx and hook ctx (`PluginHookContext = { paseo: PaseoApi; signal: AbortSignal }`). Keep a `latestPaseo` captured from the most recent hook/handler.
- `server.on(name, (event, ctx: PluginHookContext) => void | Promise<void>)` returns an unsubscribe fn. Hooks have a 30s timeout, best-effort, not replayed. Event names/payloads:
  - `agent.created` `{ agent }`
  - `agent.turn_started` `{ agent, turnId: string | null }`
  - `agent.turn_ended` `{ agent, turnId: string | null, outcome, timeline: readonly AgentTimelineItem[] }`; `outcome = {kind:"completed"} | {kind:"failed", error:{message,code?}} | {kind:"canceled", reason}`
  - `agent.permission_requested` `{ agent, request: AgentPermissionRequest }` (`request.id`, `name`, `kind`, `title?`, `description?`)
  - `agent.permission_resolved` `{ agent, requestId, resolution }`
  - `agent.archived` `{ agent, archivedAt: string }`; `agent.closed` `{ agent }`
  - `workspace.created|archived` `{ workspace }`
  - `PluginHookAgent = { id, workspaceId: string|null, parentAgentId: string|null, provider, cwd, title: string|null }`
- `server.before(name, ...)` exists for agent.create / agent.session_open / workspace.create (unused).
- `@getpaseo/plugin/server` also exports `spawnProcess`, `execCommand`, `terminateProcess` (host process helpers) in addition to node:child_process being usable server-side.
- Timeline items: `user_message {text,messageId?,clientMessageId?}`, `assistant_message {text,messageId?}`, `reasoning {text}`, tool calls, `todo`, `error {message}`, `notification {level,message}`, compaction, plugin items. Permission-waiting agents report status `running`.

## PaseoApi (server handler/hook ctx; also `usePaseo()` / `client.paseo` on client)
- `agents.list(opts?)` -> `{ requestId, entries, pageInfo:{nextCursor|null, prevCursor|null, hasMore}, subscriptionId? }`; with `subscribe:{}` also returns `subscription` (OwnedSubscription).
  - opts: `{ scope?:"active", filter?:{labels?, projectKeys?, statuses?, includeArchived?, requiresAttention?, thinkingOptionId?}, sort?:[{key:"title"|"status_priority"|"created_at"|"updated_at", direction:"asc"|"desc"}], page?:{limit, cursor?}, subscribe?, sync?, signal?, timeout? }`. NOTE: limit goes in `page`, not top-level.
  - entry = `{ agent: AgentSnapshotPayload, project: { projectKey, projectName, workspaceName?: string|null, checkout: { cwd, isGit, currentBranch: string|null, remoteUrl, worktreeRoot?, isPaseoOwnedWorktree, mainRepoRoot } , ... } }`.
- AgentSnapshotPayload: `id, provider, cwd, workspaceId?, model|null, thinkingOptionId?, createdAt, updatedAt (ISO strings), lastUserMessageAt|null, status: "initializing"|"idle"|"running"|"error"|"closed", activeTurn?:{turnId,startedAt}|null, currentModeId, pendingPermissions: AgentPermissionRequest[], lastError?, title|null, labels, requiresAttention?, attentionReason?: "finished"|"error"|"permission"|null, attentionTimestamp?, archivedAt?: string|null, providerUnavailable?`. (The plugin-facing `PluginAgentSnapshot` on the client is a smaller structural subset.)
- `agents.ref(idOrAgent)` -> `PaseoAgentHandle`: `id`, `current()`, `refresh(): Promise<{agent, project}|null>`, `archive(): Promise<{archivedAt}>`, `send`, `run`, `subscribe(handler)`, `timeline.refetch(opts)`, `timeline.append(...)`. Handle fields (`status`, `archivedAt`, ...) are null until a snapshot is observed.
- `agents.subscribe(handler)` local agent_update listener (client uses it to trigger early refresh; call `agents.list({subscribe:{}})` to start the stream).
- `timeline.refetch({ direction?: "tail"|"before"|"after", cursor?, limit?, projection?: "projected"|"canonical", requestId? })` -> `{ agent|null, direction, projection, epoch, reset, gap, startCursor, endCursor, hasOlder, hasNewer, entries, error }`; each entry = `{ provider, item: AgentTimelineItem, turnId?: string, timestamp: string, seqStart, seqEnd, sourceSeqRanges, collapsed }`. YES timeline entries carry optional `turnId`.
- No API to set agent title: use CLI `paseo agent update <id> --name <t> --home $PASEO_HOME --json` (PASEO_CLI env, else PATH).

## Client (`@getpaseo/plugin/client`)
- `default export function contribute(client: PluginClientContext): PluginCleanup`.
- `PluginClientContext` (also `PluginCommandCapabilities`): `paseo`, `rpc(contract,input)`, `openScreen({screenId, params?: Record<string,string>})`, `openSettings(id)`, `addScreen({id, title: string | (params)=>string, Component: ComponentType<PluginScreenProps>})`, `addSidebarHeaderItem({id, title, Component: ComponentType<PluginSidebarItemProps>})` (also `addSidebarFooterItem`), `addSettingsScreen({id,title,icon,Component: ComponentType<PluginSurfaceProps>})`, `addCommandCenterItem({id,title,icon,keywords?, context:"global"|"workspace"|"agent", onSelect(ctx)})` (global ctx = capabilities: `paseo, rpc, openScreen, openSettings`), `addSlashCommand`, `addHeaderButton`, `addComposerPill`, `addWorkspacePanel`, `addTheme`, `playAudio`. Deprecated: `addSurface`, `addSidebarItem`.
- Props:
  - `PluginHostProps = { theme: PluginTheme; host:{id,label}; layout:{compact:boolean; platform:"ios"|"android"|"web"} }`
  - `PluginTheme.colors`: `surface0, surface1, surface2, border, foreground, foregroundMuted, accent, accentForeground, statusSuccess, statusWarning, statusDanger`.
  - `PluginScreenProps = PluginHostProps & { params: Record<string,string>; navigation?: { openAgent({agentId, serverId?}); openWorkspace({workspaceId, serverId?}); openBrowser? } }` (navigation may be undefined: hide dependent affordances).
  - `PluginSidebarItemProps = PluginHostProps & { currentScreen: {screenId, params}|null; openScreen({screenId, params?}); openPopover(Content: ComponentType<PluginPopoverProps>) }`
  - `PluginPopoverProps = PluginHostProps & { close(); openScreen(input) }`
- Hooks (root of `/client`): `usePaseo(): PaseoApi`, `useRpc(contract): (input) => Promise<output>`, `useSettings(def): SettingsState` where `SettingsState = ({status:"loading"} | {status:"error";error} | {status:"invalid";error;revision} | {status:"ready"; values; revision}) & { saving:boolean; saveError:string|null; save(values, revision): Promise<boolean>; reset(): Promise<boolean>; reload(): Promise<void> }`. `useAgent`/`useWorkspace` throw inside screens/sidebar - do not use. Also `useHosts`, `getPaseoClient`, `openExternalUrl` from `/client/host`-style exports (check index).
- `@getpaseo/plugin/client/react-native`: `Icon` ({name (Lucide), size?, color?}), `Modal` (`{title, icon?, open, onOpenChange, children}` + `Modal.Content {children, style?, contentContainerStyle?, scrollable?}`), `useToast(): { show(msg, {variant?, durationMs?}), error(msg) }`, `ScrollView`, `FlatList`, `TextInput`, `copyText(text)`.
- `@getpaseo/plugin/client/ui`: `SettingsSection/Group {title, info?, trailing?}`, `SettingsCard`, `SettingsRow {label, hint?, error?}`, `SettingsSwitch {value,onValueChange,disabled?}`, `SettingsSelect<V> {value, options:{label,value}[], onValueChange}`, `SettingsInput {initialValue?, onChangeText, placeholder?, disabled?, ref?: SettingsInputHandle{focus,blur,getText,replaceText}}`, `SettingsAction {actionLabel, onPress}`, `ExternalLink`, `SidebarRow {id?, icon?, label?, onPress, active?, trailing?}`, `SidebarSeparator`.
- Plain `react-native` (View, Text, Pressable, Animated, PanResponder, StyleSheet) is available for drag/drop.

## Reference patterns
- herald: `server/host-types.ts` (types from plugin), `shared/settings.ts` (`defineSettings` id/scope host/version 1 with zod defaults, plus `DEFAULT_*` const), `shared/herald.ts` (`defineRpc` contracts next to zod schemas).
- agent-monitor: `shared/monitor-settings.ts` (zod defaults from a DEFAULT const), `index.client.tsx` (addSettingsScreen + addScreen + addSidebarHeaderItem + addCommandCenterItem, collect cleanups, return a combined remover; falls back to addSurface on hosts without screens).

## shared/ contracts (this project)
`types.ts`, `analysis-config.ts`, `settings.ts` (ANALYZER_SETTINGS, AnalyzerSettings, DEFAULT_ANALYZER_SETTINGS), `rpc.ts` (snapshotRpc, detailRpc, reanalyzeRpc, setManualStatusRpc, clearManualStatusRpc, applyGeneratedTitleRpc, forgetRpc, stopAgentRpc, testAnalyzerRpc), `presentation.ts`, `project-filter.ts`, `drop-target.ts`, `test-fixtures.ts` (makeSession test helper). Settings `thinkingLevel` is a free string (validate with `normalizeAnalysisConfig`).
