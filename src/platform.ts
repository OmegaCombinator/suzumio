import { ProjectStore } from "./store.js";
import type { FeishuInboundChatType, FeishuInboundConfig, FeishuPlatformConfig, JsonObject, MessageRecord, PlatformReceiveIdType } from "./types.js";

type TickProject = (project: string) => Promise<void>;

type RunningPlatform = {
  key: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type EventRow = {
  id: string;
  type: string;
  data_json: string;
  created_at: string;
};

type FeishuCredentials = {
  appId: string;
  appSecret: string;
};

type FeishuRoute = {
  messageId?: string;
  receiveId?: string;
  receiveIdType?: PlatformReceiveIdType;
};

type FeishuReactionAckResult = {
  emojiType: string;
  reactionId?: string;
  error?: string;
};

export type ParsedFeishuMention = {
  key?: string;
  name?: string;
  openId?: string;
  userId?: string;
  unionId?: string;
};

export type ParsedFeishuReceiveEvent = {
  eventId?: string;
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  chatId: string;
  chatType?: string;
  messageType?: string;
  content: string;
  text: string;
  mentions: ParsedFeishuMention[];
  senderType?: string;
  senderOpenId?: string;
  senderUserId?: string;
  senderUnionId?: string;
  tenantKey?: string;
};

export class PlatformManager {
  private readonly running = new Map<string, RunningPlatform>();
  private discoverTimer?: NodeJS.Timeout;

  constructor(private readonly root: string | undefined, private readonly tickProject: TickProject) {}

  async startAll(): Promise<void> {
    await this.refresh();
    this.discoverTimer = setInterval(() => void this.refresh().catch((error) => console.warn("platform refresh failed", error)), 10_000);
    this.discoverTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.discoverTimer) clearInterval(this.discoverTimer);
    const platforms = [...this.running.values()];
    this.running.clear();
    await Promise.all(platforms.map((platform) => platform.stop().catch((error) => console.warn(`platform stop failed: ${platform.key}`, error))));
  }

  private async refresh(): Promise<void> {
    const wanted = new Set<string>();
    for (const project of await ProjectStore.list(this.root)) {
      const store = new ProjectStore(project, this.root);
      try {
        const config = store.config();
        for (const platform of config.platforms ?? []) {
          if (!platform.enabled) continue;
          const key = `${project}/${platform.id}`;
          wanted.add(key);
          if (this.running.has(key)) continue;
          const bridge = this.createBridge(project, platform, key);
          this.running.set(key, bridge);
          bridge.start().catch((error) => {
            this.running.delete(key);
            console.warn(`platform start failed: ${key}`, error instanceof Error ? error.message : String(error));
          });
        }
      } finally {
        store.close();
      }
    }
    for (const [key, platform] of this.running) {
      if (wanted.has(key)) continue;
      this.running.delete(key);
      await platform.stop().catch((error) => console.warn(`platform stop failed: ${key}`, error));
    }
  }

  private createBridge(project: string, config: FeishuPlatformConfig, key: string): RunningPlatform {
    if (config.kind === "feishu") return new FeishuPlatformBridge(project, config, key, this.root, this.tickProject);
    throw new Error(`Unsupported platform kind: ${(config as { kind?: string }).kind}`);
  }
}

class FeishuPlatformBridge implements RunningPlatform {
  private credentials?: FeishuCredentials;
  private token?: { value: string; expiresAt: number };
  private wsClient?: { start?: unknown; stop?: () => Promise<void> | void; close?: () => Promise<void> | void };
  private outboundTimer?: NodeJS.Timeout;
  private readonly seenEventIds = new Set<string>();
  private botOpenId?: string;

  constructor(
    private readonly project: string,
    private readonly config: FeishuPlatformConfig,
    readonly key: string,
    private readonly root: string | undefined,
    private readonly tickProject: TickProject,
  ) {}

  async start(): Promise<void> {
    if (!this.config.inbound.enabled && !this.config.outbound.enabled) return;
    this.credentials = resolveCredentials(this.config);
    if (this.config.outbound.enabled) this.startOutboundLoop();
    if (this.config.inbound.enabled) await this.startInbound();
    console.log(`platform ${this.key} started`);
  }

  async stop(): Promise<void> {
    if (this.outboundTimer) clearInterval(this.outboundTimer);
    await this.wsClient?.stop?.();
    await this.wsClient?.close?.();
  }

  private async startInbound(): Promise<void> {
    const lark = await import("@larksuiteoapi/node-sdk") as Record<string, unknown>;
    const EventDispatcher = lark.EventDispatcher as new (config: Record<string, unknown>) => { register: (handlers: Record<string, (data: unknown) => Promise<void>>) => unknown };
    const WSClient = lark.WSClient as new (config: Record<string, unknown>) => { start: (input: Record<string, unknown>) => void; stop?: () => Promise<void> | void; close?: () => Promise<void> | void };
    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => this.handleReceiveEvent(data),
    });
    const credentials = this.requireCredentials();
    const wsClient = new WSClient({ appId: credentials.appId, appSecret: credentials.appSecret });
    this.wsClient = wsClient;
    wsClient.start({ eventDispatcher: dispatcher });
  }

  private startOutboundLoop(): void {
    const store = new ProjectStore(this.project, this.root);
    try {
      for (const event of store.listEvents(500) as EventRow[]) this.seenEventIds.add(event.id);
    } finally {
      store.close();
    }
    this.outboundTimer = setInterval(() => void this.pollOutbound().catch((error) => console.warn(`platform outbound failed: ${this.key}`, error)), this.config.outbound.pollIntervalMs);
    this.outboundTimer.unref();
  }

  private async handleReceiveEvent(data: unknown): Promise<void> {
    const parsed = parseFeishuReceiveEvent(data);
    if (!parsed) return;
    if (parsed.senderType && parsed.senderType !== "user") return;
    if (!(await this.acceptsInbound(parsed))) return;
    if (this.hasInboundRecord(parsed.messageId)) return;
    const reactionAck = await this.addInboundReactionAck(parsed);
    const store = new ProjectStore(this.project, this.root);
    let inserted = false;
    try {
      if (hasPlatformEvent(store, "platform.feishu.inbound", this.config.id, "feishuMessageId", parsed.messageId)) return;
      const message = store.sendMessage({
        sender: this.config.inbound.sender,
        recipient: this.config.inbound.recipient,
        priority: this.config.inbound.priority,
        body: renderFeishuInboundMessage(parsed, this.config.inbound.includeMetadata),
      });
      store.appendEvent("platform.feishu.inbound", {
        platformId: this.config.id,
        feishuMessageId: parsed.messageId,
        feishuEventId: parsed.eventId,
        chatId: parsed.chatId,
        chatType: parsed.chatType,
        messageType: parsed.messageType,
        senderOpenId: parsed.senderOpenId,
        senderUserId: parsed.senderUserId,
        senderUnionId: parsed.senderUnionId,
        suzumioMessageId: message.id,
      });
      if (reactionAck) {
        store.appendEvent(reactionAck.error ? "platform.feishu.inbound_reaction_failed" : "platform.feishu.inbound_reaction", {
          platformId: this.config.id,
          feishuMessageId: parsed.messageId,
          emojiType: reactionAck.emojiType,
          reactionId: reactionAck.reactionId,
          error: reactionAck.error,
        });
      }
      inserted = true;
    } finally {
      store.close();
    }
    if (inserted) await this.tickProject(this.project);
  }

  private async acceptsInbound(parsed: ParsedFeishuReceiveEvent): Promise<boolean> {
    let botOpenId: string | undefined;
    if (parsed.chatType === "group" && this.config.inbound.groupMessageMode === "bot_mentions") {
      if (parsed.mentions.length === 0) return false;
      try {
        botOpenId = await this.inboundBotOpenId();
      } catch (error) {
        console.warn(`platform inbound filter failed: ${this.key}`, error instanceof Error ? error.message : String(error));
        return false;
      }
    }
    return shouldAcceptFeishuInboundEvent(parsed, this.config.inbound, botOpenId);
  }

  private hasInboundRecord(feishuMessageId: string): boolean {
    const store = new ProjectStore(this.project, this.root);
    try {
      return hasPlatformEvent(store, "platform.feishu.inbound", this.config.id, "feishuMessageId", feishuMessageId);
    } finally {
      store.close();
    }
  }

  private async addInboundReactionAck(parsed: ParsedFeishuReceiveEvent): Promise<FeishuReactionAckResult | undefined> {
    const ack = this.config.inbound.reactionAck;
    if (!ack.enabled) return undefined;
    try {
      const sent = await this.createReaction(parsed.messageId, ack.emojiType);
      return { emojiType: ack.emojiType, reactionId: sent.reactionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`platform inbound reaction failed: ${this.key}`, message);
      return { emojiType: ack.emojiType, error: message };
    }
  }

  private async inboundBotOpenId(): Promise<string> {
    const configured = resolveInboundBotOpenId(this.config);
    if (configured) return configured;
    if (this.botOpenId) return this.botOpenId;
    const token = await this.tenantAccessToken();
    const result = await this.feishuJson("GET", "/open-apis/bot/v3/info", token, undefined);
    const openId = nestedString(result, "data", "open_id") ?? nestedString(result, "bot", "open_id");
    if (!openId) throw new Error("Feishu bot info did not include open_id");
    this.botOpenId = openId;
    return openId;
  }

  private async pollOutbound(): Promise<void> {
    const store = new ProjectStore(this.project, this.root);
    try {
      const events = (store.listEvents(500) as EventRow[]).reverse();
      for (const event of events) {
        if (this.seenEventIds.has(event.id)) continue;
        this.seenEventIds.add(event.id);
        if (event.type !== "message.created") continue;
        await this.handleSuzumioMessageEvent(store, event);
      }
    } finally {
      store.close();
    }
  }

  private async handleSuzumioMessageEvent(store: ProjectStore, event: EventRow): Promise<void> {
    const message = parseEventData<MessageRecord>(event.data_json);
    if (!message || message.recipient !== this.config.outbound.recipient) return;
    if (hasPlatformEvent(store, "platform.feishu.outbound", this.config.id, "suzumioMessageId", message.id)) return;
    const route = latestInboundRoute(store, this.config) ?? defaultOutboundRoute(this.config);
    if (!route) {
      store.appendEvent("platform.feishu.outbound_skipped", { platformId: this.config.id, suzumioMessageId: message.id, reason: "no Feishu route" });
      return;
    }
    try {
      const sent = route.messageId && this.config.outbound.replyToLastInbound
        ? await this.replyText(route.messageId, renderFeishuOutboundText(message))
        : await this.sendText(route.receiveIdType ?? "chat_id", requiredString(route.receiveId, "receiveId"), renderFeishuOutboundText(message));
      store.appendEvent("platform.feishu.outbound", {
        platformId: this.config.id,
        suzumioMessageId: message.id,
        feishuMessageId: sent.messageId,
        route,
      });
    } catch (error) {
      store.appendEvent("platform.feishu.outbound_failed", {
        platformId: this.config.id,
        suzumioMessageId: message.id,
        route,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendText(receiveIdType: PlatformReceiveIdType, receiveId: string, text: string): Promise<{ messageId?: string }> {
    const token = await this.tenantAccessToken();
    const result = await this.feishuJson("POST", "/open-apis/im/v1/messages", token, {
      receive_id: receiveId,
      msg_type: "text",
      content: JSON.stringify({ text: truncateFeishuText(text) }),
    }, { receive_id_type: receiveIdType });
    return { messageId: nestedString(result, "data", "message_id") };
  }

  private async replyText(messageId: string, text: string): Promise<{ messageId?: string }> {
    const token = await this.tenantAccessToken();
    const result = await this.feishuJson("POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, token, {
      msg_type: "text",
      content: JSON.stringify({ text: truncateFeishuText(text) }),
    });
    return { messageId: nestedString(result, "data", "message_id") };
  }

  private async createReaction(messageId: string, emojiType: string): Promise<{ reactionId?: string }> {
    const token = await this.tenantAccessToken();
    const result = await this.feishuJson("POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, token, {
      reaction_type: { emoji_type: emojiType },
    });
    return { reactionId: nestedString(result, "data", "reaction_id") };
  }

  private async tenantAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - Date.now() > 60_000) return this.token.value;
    const credentials = this.requireCredentials();
    const result = await this.feishuJson("POST", "/open-apis/auth/v3/tenant_access_token/internal", undefined, {
      app_id: credentials.appId,
      app_secret: credentials.appSecret,
    });
    const token = requiredString(result.tenant_access_token, "tenant_access_token");
    const expireSeconds = typeof result.expire === "number" && Number.isFinite(result.expire) ? result.expire : 7_200;
    this.token = { value: token, expiresAt: Date.now() + Math.max(60, expireSeconds - 60) * 1_000 };
    return token;
  }

  private async feishuJson(method: string, path: string, token: string | undefined, body: unknown, query?: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(path, "https://open.feishu.cn");
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
    if (token) headers.authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") init.body = JSON.stringify(body ?? {});
    const response = await fetch(url, init);
    const raw = await response.text();
    const data = parseJsonObject(raw);
    const code = typeof data.code === "number" ? data.code : 0;
    if (!response.ok || code !== 0) {
      const msg = typeof data.msg === "string" ? data.msg : response.statusText;
      throw new Error(`Feishu API ${method} ${path} failed: code=${code} status=${response.status} msg=${msg}`);
    }
    return data;
  }

  private requireCredentials(): FeishuCredentials {
    if (!this.credentials) this.credentials = resolveCredentials(this.config);
    return this.credentials;
  }
}

export function parseFeishuReceiveEvent(data: unknown): ParsedFeishuReceiveEvent | undefined {
  const top = asObject(data);
  const header = asObject(top?.header);
  const event = asObject(top?.event) ?? top;
  const message = asObject(event?.message);
  const sender = asObject(event?.sender);
  const senderId = asObject(sender?.sender_id);
  const messageId = optionalString(message?.message_id);
  const chatId = optionalString(message?.chat_id);
  if (!messageId || !chatId) return undefined;
  const messageType = optionalString(message?.message_type);
  const content = optionalString(message?.content) ?? "";
  return {
    eventId: optionalString(header?.event_id),
    messageId,
    rootId: optionalString(message?.root_id),
    parentId: optionalString(message?.parent_id),
    threadId: optionalString(message?.thread_id),
    chatId,
    chatType: optionalString(message?.chat_type),
    messageType,
    content,
    text: parseFeishuMessageText(messageType, content),
    mentions: parseFeishuMentions(message?.mentions),
    senderType: optionalString(sender?.sender_type),
    senderOpenId: optionalString(senderId?.open_id),
    senderUserId: optionalString(senderId?.user_id),
    senderUnionId: optionalString(senderId?.union_id),
    tenantKey: optionalString(sender?.tenant_key) ?? optionalString(header?.tenant_key),
  };
}

export function shouldAcceptFeishuInboundEvent(event: ParsedFeishuReceiveEvent, inbound: FeishuInboundConfig, botOpenId?: string): boolean {
  const chatType = toFeishuInboundChatType(event.chatType);
  if (!chatType || !inbound.allowedChatTypes.includes(chatType)) return false;
  if (chatType !== "group") return true;
  if (inbound.groupMessageMode === "all") return true;
  return !!botOpenId && event.mentions.some((mention) => mention.openId === botOpenId);
}

export function renderFeishuInboundMessage(event: ParsedFeishuReceiveEvent, includeMetadata = true): string {
  const lines = [event.text.trim() || `[${event.messageType ?? "unknown"} message with empty text]`];
  if (!includeMetadata) return lines.join("\n");
  lines.push("", "---", "Feishu metadata:");
  lines.push(`message_id: ${event.messageId}`);
  lines.push(`chat_id: ${event.chatId}`);
  if (event.chatType) lines.push(`chat_type: ${event.chatType}`);
  if (event.senderOpenId) lines.push(`sender_open_id: ${event.senderOpenId}`);
  if (event.senderUserId) lines.push(`sender_user_id: ${event.senderUserId}`);
  if (event.threadId) lines.push(`thread_id: ${event.threadId}`);
  return lines.join("\n");
}

function parseFeishuMessageText(messageType: string | undefined, content: string): string {
  const parsed = parseJsonObject(content);
  if (messageType === "text") return optionalString(parsed.text) ?? content;
  if (messageType === "post") return JSON.stringify(parsed.post ?? parsed, null, 2);
  if (messageType === "image") return `[image: ${optionalString(parsed.image_key) ?? "unknown"}]`;
  if (messageType === "file") return `[file: ${optionalString(parsed.file_key) ?? "unknown"}]`;
  return content || `[${messageType ?? "unknown"}]`;
}

function parseFeishuMentions(value: unknown): ParsedFeishuMention[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const mention = asObject(item);
    if (!mention) return [];
    const id = asObject(mention.id);
    const parsed = {
      key: optionalString(mention.key),
      name: optionalString(mention.name),
      openId: optionalString(id?.open_id),
      userId: optionalString(id?.user_id),
      unionId: optionalString(id?.union_id),
    };
    return parsed.key || parsed.name || parsed.openId || parsed.userId || parsed.unionId ? [parsed] : [];
  });
}

function toFeishuInboundChatType(value: string | undefined): FeishuInboundChatType | undefined {
  return value === "group" || value === "p2p" ? value : undefined;
}

function renderFeishuOutboundText(message: MessageRecord): string {
  return message.sender && message.sender !== "user" ? `[${message.sender}] ${message.body}` : message.body;
}

function latestInboundRoute(store: ProjectStore, config: FeishuPlatformConfig): FeishuRoute | undefined {
  const latest = store.latestEvent({
    type: "platform.feishu.inbound",
    match: (data) => data.platformId === config.id && typeof data.chatId === "string",
  });
  if (!latest) return undefined;
  return {
    messageId: optionalString(latest.data.feishuMessageId),
    receiveId: optionalString(latest.data.chatId),
    receiveIdType: "chat_id",
  };
}

function defaultOutboundRoute(config: FeishuPlatformConfig): FeishuRoute | undefined {
  const receiveId = config.outbound.defaultReceiveId ?? (config.outbound.defaultReceiveIdEnv ? process.env[config.outbound.defaultReceiveIdEnv] : undefined);
  if (!receiveId) return undefined;
  return { receiveId, receiveIdType: config.outbound.defaultReceiveIdType };
}

function hasPlatformEvent(store: ProjectStore, type: string, platformId: string, field: string, value: string): boolean {
  return store.latestEvent({ type, match: (data) => data.platformId === platformId && data[field] === value }) !== undefined;
}

function resolveCredentials(config: FeishuPlatformConfig): FeishuCredentials {
  const appId = config.appId ?? (config.appIdEnv ? process.env[config.appIdEnv] : undefined);
  const appSecret = config.appSecret ?? (config.appSecretEnv ? process.env[config.appSecretEnv] : undefined);
  if (!appId) throw new Error(`Feishu platform ${config.id} is missing appId or env ${config.appIdEnv}`);
  if (!appSecret) throw new Error(`Feishu platform ${config.id} is missing appSecret or env ${config.appSecretEnv}`);
  return { appId, appSecret };
}

function resolveInboundBotOpenId(config: FeishuPlatformConfig): string | undefined {
  return config.inbound.botOpenId ?? (config.inbound.botOpenIdEnv ? process.env[config.inbound.botOpenIdEnv] : undefined);
}

function parseEventData<T>(json: string): T | undefined {
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return asObject(parsed) ?? {};
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required`);
  return value;
}

function nestedString(value: Record<string, unknown>, key: string, nestedKey: string): string | undefined {
  return optionalString(asObject(value[key])?.[nestedKey]);
}

function truncateFeishuText(text: string): string {
  return text.length <= 140_000 ? text : `${text.slice(0, 140_000)}\n\n[truncated ${text.length - 140_000} chars]`;
}
