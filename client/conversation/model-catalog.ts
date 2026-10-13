/**
 * Provider model catalog, cached per provider across panes (Paseo keeps the
 * same catalog for the app lifetime). Only successful loads are cached; a
 * failed fetch retries on the next caller. No async arrows (Hermes).
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";

type Paseo = PluginClientContext["paseo"];
type ModelsResult = Awaited<ReturnType<Paseo["providers"]["listModels"]>>;
export type ModelCatalogEntry = NonNullable<ModelsResult["models"]>[number];

const cache = new Map<string, readonly ModelCatalogEntry[]>();

/** Cached catalog when a previous pane already loaded it, else undefined. */
export function cachedModelCatalog(provider: string): readonly ModelCatalogEntry[] | undefined {
  return cache.get(provider);
}

/** Loads (and caches) the provider's model list; null when the call fails. */
export async function modelCatalogFor(
  paseo: Paseo,
  provider: string,
): Promise<readonly ModelCatalogEntry[] | null> {
  const hit = cache.get(provider);
  if (hit !== undefined) {
    return hit;
  }
  try {
    const result = await paseo.providers.listModels(provider);
    const models = result.models ?? [];
    cache.set(provider, models);
    return models;
  } catch {
    return null;
  }
}
