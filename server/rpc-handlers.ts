import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  applyGeneratedTitleRpc,
  clearManualStatusRpc,
  detailRpc,
  forgetRpc,
  reanalyzeRpc,
  setManualStatusRpc,
  snapshotRpc,
  stopAgentRpc,
  testAnalyzerRpc,
} from "../shared/rpc";
import { stopAgentViaCli } from "./stop-agent";
import type { SessionManagerService } from "./service";

export function registerRpcHandlers(server: PluginServerContext, service: SessionManagerService): void {
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
