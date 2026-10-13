import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  announcementsRpc,
  applyGeneratedTitleRpc,
  clearDeferRpc,
  clearManualStatusRpc,
  deferRpc,
  detailRpc,
  draftGetRpc,
  draftSetRpc,
  forgetRpc,
  magpieModelsRpc,
  mermaidRenderRpc,
  reanalyzeRpc,
  resumeRpc,
  dismissResumeRpc,
  piModelsRpc,
  setAgentModeRpc,
  setAgentThinkingRpc,
  setManualStatusRpc,
  snapshotRpc,
  speechRenderRpc,
  speechVoicesRpc,
  stopAgentRpc,
  testAnalyzerRpc,
} from "../shared/rpc";
import { setAgentModeViaCli, setAgentThinkingViaCli } from "./agent-cli";
import type { AnnouncementFeed } from "./announcements";
import type { DraftStore } from "./drafts";
import { DEFAULT_MAGPIE_BASE_URL } from "./analyzer/magpie";
import { renderMermaid } from "./mermaid";
import { listMagpieModels, listPiModels } from "./pi-models";
import { listSayVoices, renderWithSay, sayAvailable } from "./say";
import { stopAgentViaCli } from "./stop-agent";
import type { SessionManagerService } from "./service";

export function registerRpcHandlers(
  server: PluginServerContext,
  service: SessionManagerService,
  feed: AnnouncementFeed,
  drafts: DraftStore,
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
  server.handle(mermaidRenderRpc, (input) => {
    return renderMermaid(input.code, input.theme);
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
  server.handle(deferRpc, (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.defer(input.sessionId, input.durationMs, input.toQueue);
  });
  server.handle(clearDeferRpc, (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.clearDefer(input.sessionId);
  });
  server.handle(applyGeneratedTitleRpc, async (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.applyGeneratedTitle(input.sessionId);
  });
  server.handle(forgetRpc, (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.forget(input.sessionId);
  });
  server.handle(resumeRpc, async (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.resume(input.sessionId);
  });
  server.handle(dismissResumeRpc, (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.dismissResume(input.sessionId);
  });
  server.handle(stopAgentRpc, async (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return stopAgentViaCli(input.sessionId);
  });
  server.handle(setAgentModeRpc, async (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return setAgentModeViaCli(input.sessionId, input.modeId);
  });
  server.handle(setAgentThinkingRpc, async (input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return setAgentThinkingViaCli(input.sessionId, input.thinkingOptionId);
  });
  server.handle(draftGetRpc, async (input) => {
    await drafts.load();
    return { draft: drafts.get(input.sessionId) };
  });
  server.handle(draftSetRpc, async (input) => {
    await drafts.load();
    drafts.set(input.sessionId, input.draft);
    return { ok: true };
  });
  server.handle(testAnalyzerRpc, async (_input, ctx) => {
    service.touchPaseo(ctx.paseo);
    return service.testAnalyzer();
  });
  server.handle(piModelsRpc, async () => {
    const settings = await service.currentAnalyzerSettings();
    return listPiModels(settings.command);
  });
  server.handle(magpieModelsRpc, async () => {
    const settings = await service.currentAnalyzerSettings();
    return listMagpieModels(settings.magpieBaseUrl.trim() || DEFAULT_MAGPIE_BASE_URL);
  });
}
