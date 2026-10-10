import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  announcementsRpc,
  applyGeneratedTitleRpc,
  clearManualStatusRpc,
  detailRpc,
  forgetRpc,
  reanalyzeRpc,
  setManualStatusRpc,
  snapshotRpc,
  speechRenderRpc,
  speechVoicesRpc,
  stopAgentRpc,
  testAnalyzerRpc,
} from "../shared/rpc";
import type { AnnouncementFeed } from "./announcements";
import { listSayVoices, renderWithSay, sayAvailable } from "./say";
import { stopAgentViaCli } from "./stop-agent";
import type { SessionManagerService } from "./service";

export function registerRpcHandlers(
  server: PluginServerContext,
  service: SessionManagerService,
  feed: AnnouncementFeed,
): void {
  server.handle(announcementsRpc, (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return feed.since(input.since);
  });
  server.handle(speechVoicesRpc, async () => {
    if (!(await sayAvailable())) {
      return { available: false, voices: [] };
    }
    try {
      return { available: true, voices: await listSayVoices() };
    } catch (error) {
      console.warn("[session-manager] could not list say voices", error);
      return { available: false, voices: [] };
    }
  });
  server.handle(speechRenderRpc, async (input) => {
    if (!(await sayAvailable())) {
      throw new Error("守护进程所在机器不支持 say（仅 macOS）");
    }
    return renderWithSay(input.text, { voice: input.voice, rate: input.rate });
  });
  server.handle(snapshotRpc, async (_input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.snapshot();
  });
  server.handle(detailRpc, (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return { session: service.detail(input.sessionId) };
  });
  server.handle(reanalyzeRpc, (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.reanalyze(input.sessionId);
  });
  server.handle(setManualStatusRpc, (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.setManualStatus(input.sessionId, input.status);
  });
  server.handle(clearManualStatusRpc, (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.clearManualStatus(input.sessionId);
  });
  server.handle(applyGeneratedTitleRpc, async (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.applyGeneratedTitle(input.sessionId);
  });
  server.handle(forgetRpc, (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.forget(input.sessionId);
  });
  server.handle(stopAgentRpc, async (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return stopAgentViaCli(input.sessionId);
  });
  server.handle(testAnalyzerRpc, async (_input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.testAnalyzer();
  });
}
