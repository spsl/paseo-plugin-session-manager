import type { PluginLifecycleEvents, PluginHookContext, PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import type { SessionManagerService } from "./service";

/** Registers lifecycle hooks; handlers are synchronous and never await LLM work. */
export function registerHooks(
  server: PluginLifecycleRegistration,
  service: SessionManagerService,
): () => void {
  const guard = <Name extends keyof PluginLifecycleEvents>(
    name: Name,
    handle: (event: PluginLifecycleEvents[Name]) => void,
  ): (() => void) =>
    server.on(name, (event, ctx: PluginHookContext) => {
      try {
        service.touchPaseo(ctx.paseo);
        handle(event);
      } catch (error) {
        console.error(`[session-manager] ${name} handler failed`, error);
      }
    });
  const unsubscribes = [
    guard("agent.created", (event) => service.onCreated(event)),
    guard("agent.turn_started", (event) => service.onTurnStarted(event)),
    guard("agent.turn_ended", (event) => service.onTurnEnded(event)),
    guard("agent.permission_requested", (event) => service.onPermissionRequested(event)),
    guard("agent.permission_resolved", (event) => service.onPermissionResolved(event)),
    guard("agent.closed", (event) => service.onClosed(event)),
    guard("agent.archived", (event) => service.onArchived(event)),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  };
}
