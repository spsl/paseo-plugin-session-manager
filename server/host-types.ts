/**
 * Paseo types derived from `@getpaseo/plugin/server` only. Never import
 * `@getpaseo/client` or `@getpaseo/protocol` (not installed at runtime).
 */
import type { PluginHandlerContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHandlerContext["paseo"];

export type AgentTimelineItem = PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];
export type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];
export type TurnStartedEvent = PluginLifecycleEvents["agent.turn_started"];
export type CreatedEvent = PluginLifecycleEvents["agent.created"];
export type ClosedEvent = PluginLifecycleEvents["agent.closed"];
export type ArchivedEvent = PluginLifecycleEvents["agent.archived"];
export type PermissionRequestedEvent = PluginLifecycleEvents["agent.permission_requested"];
export type PermissionResolvedEvent = PluginLifecycleEvents["agent.permission_resolved"];
export type HookAgent = CreatedEvent["agent"];
export type TurnOutcomeEvent = TurnEndedEvent["outcome"];

export type AgentListResult = Awaited<ReturnType<PaseoApi["agents"]["list"]>>;
export type AgentListEntry = AgentListResult["entries"][number];
export type AgentSnapshot = AgentListEntry["agent"];
export type AgentProject = AgentListEntry["project"];

export type TimelineFetchResult = Awaited<
  ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>
>;
export type TimelineEntry = TimelineFetchResult["entries"][number];
