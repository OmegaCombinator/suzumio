import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { assertNodeFetchProxySupported, hasProxyEnv, proxyForUrl } from "./proxy.js";
import type { ModelPresetConfig, ModelRegistryConfig, ProviderConfig } from "./types.js";

type FetchWithDispatcher = (url: Parameters<typeof fetch>[0], init?: RequestInit & { dispatcher: Dispatcher }) => ReturnType<typeof fetch>;
const fetchWithDispatcher = undiciFetch as unknown as FetchWithDispatcher;

export type ResolvedRunnerModel = {
  presetId: string;
  selectedPresetId: string;
  preset: ModelPresetConfig;
  providerId: string;
  provider: ProviderConfig;
  apiModel: string;
  languageModel: unknown;
};

export function resolveRunnerModels(models: ModelRegistryConfig, presetId?: string): ResolvedRunnerModel[] {
  if (!presetId) throw new Error("No model preset selected. Set backend.runner.model or agents.<id>.model explicitly.");
  return expandPreset(models, presetId, presetId, []);
}

function expandPreset(models: ModelRegistryConfig, presetId: string, selectedPresetId: string, stack: string[]): ResolvedRunnerModel[] {
  if (stack.includes(presetId)) throw new Error(`Circular model-list preset: ${[...stack, presetId].join(" -> ")}`);
  const preset = models.presets[presetId];
  if (!preset) throw new Error(`Model preset not found: ${presetId}`);
  if (preset.modelList) return preset.modelList.flatMap((id) => expandPreset(models, id, selectedPresetId, [...stack, presetId]));
  if (!preset.provider || !preset.model) throw new Error(`Model preset needs provider and model: ${presetId}`);
  const provider = models.providers[preset.provider];
  if (!provider) throw new Error(`Provider not found: ${preset.provider}`);
  const apiModel = preset.apiModel ?? preset.model;
  const languageModel = selectLanguageModel(createProvider(preset.provider, provider), apiModel, provider.type);
  return [{ presetId, selectedPresetId, preset, providerId: preset.provider, provider, apiModel, languageModel }];
}

function createProvider(providerId: string, provider: ProviderConfig): unknown {
  const options = {
    apiKey: provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined),
    baseURL: provider.baseURL,
    headers: provider.headers,
    fetch: createProviderFetch(provider),
    ...provider.options,
  };
  switch (provider.type) {
    case "openai":
      return createOpenAI(options as never);
    case "anthropic":
      return createAnthropic(options as never);
    case "google":
      return createGoogleGenerativeAI(options as never);
    case "openai-compatible":
      return createOpenAICompatible({ name: providerId, ...options } as never);
  }
}

function createProviderFetch(provider: ProviderConfig): typeof fetch | undefined {
  if (provider.timeoutMs === undefined && provider.chunkTimeoutMs === undefined && !hasProxyEnv()) return undefined;
  const requestTimeoutMs = provider.timeoutMs === false ? undefined : provider.timeoutMs;
  const dispatcher = new Agent({
    connectTimeout: provider.timeoutMs === false ? 0 : provider.timeoutMs,
    headersTimeout: provider.timeoutMs === false ? 0 : provider.timeoutMs,
    bodyTimeout: provider.chunkTimeoutMs ?? (provider.timeoutMs === false ? 0 : provider.timeoutMs),
  } as never);
  const proxyDispatchers = new Map<string, ProxyAgent>();
  return (url, init) => {
    const proxyUrl = proxyForUrl(String(url));
    const selectedDispatcher = proxyUrl ? proxyDispatcher(proxyUrl, proxyDispatchers) : dispatcher;
    return fetchWithDispatcher(url, {
      ...init,
      signal: withTimeoutSignal(init?.signal, requestTimeoutMs),
      dispatcher: selectedDispatcher,
    });
  };
}

function proxyDispatcher(proxyUrl: string, cache: Map<string, ProxyAgent>): ProxyAgent {
  assertNodeFetchProxySupported(proxyUrl);
  let dispatcher = cache.get(proxyUrl);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(proxyUrl);
    cache.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

function withTimeoutSignal(signal: AbortSignal | null | undefined, timeoutMs: number | undefined): AbortSignal | null | undefined {
  if (!timeoutMs) return signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

function selectLanguageModel(provider: unknown, modelId: string, type: ProviderConfig["type"]): unknown {
  const sdk = provider as Record<string, unknown>;
  if (type === "openai" && typeof sdk.responses === "function") return sdk.responses(modelId);
  if (typeof provider === "function") return provider(modelId);
  if (typeof sdk.languageModel === "function") return sdk.languageModel(modelId);
  if (typeof sdk.chat === "function") return sdk.chat(modelId);
  if (typeof sdk.messages === "function") return sdk.messages(modelId);
  throw new Error(`Provider does not expose a language model factory for ${modelId}`);
}
