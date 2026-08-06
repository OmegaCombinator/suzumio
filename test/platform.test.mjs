import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { loadProjectConfig, renderProjectConfig } from "../dist/config.js";
import { parseFeishuReceiveEvent, renderFeishuInboundMessage, shouldAcceptFeishuInboundEvent } from "../dist/platform.js";

test("Feishu receive events parse into platform-neutral text", () => {
  const event = {
    schema: "2.0",
    header: {
      event_id: "evt_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender",
          user_id: "user_sender",
          union_id: "on_sender",
        },
        sender_type: "user",
        tenant_key: "tenant",
      },
      message: {
        message_id: "om_1",
        chat_id: "oc_1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 hello Suzumio" }),
        mentions: [
          {
            key: "@_user_1",
            name: "Suzumio",
            id: {
              open_id: "ou_bot",
            },
          },
        ],
      },
    },
  };

  const parsed = parseFeishuReceiveEvent(event);
  assert.equal(parsed?.messageId, "om_1");
  assert.equal(parsed?.chatId, "oc_1");
  assert.equal(parsed?.senderOpenId, "ou_sender");
  assert.equal(parsed?.text, "@_user_1 hello Suzumio");
  assert.equal(parsed?.mentions[0]?.openId, "ou_bot");

  const rendered = renderFeishuInboundMessage(parsed);
  assert.match(rendered, /hello Suzumio/);
  assert.match(rendered, /message_id: om_1/);
  assert.match(rendered, /chat_id: oc_1/);
});

test("Feishu inbound filter defaults to group bot mentions only", () => {
  const inbound = {
    enabled: true,
    recipient: "pm",
    priority: "P2",
    sender: "user",
    includeMetadata: true,
    allowedChatTypes: ["group"],
    groupMessageMode: "bot_mentions",
  };
  const botMention = {
    key: "@_user_1",
    name: "Suzumio",
    id: { open_id: "ou_bot" },
  };
  const groupMention = parseFeishuReceiveEvent(receiveEvent({ messageId: "om_group_mention", chatType: "group", text: "@_user_1 run", mentions: [botMention] }));
  const groupPlain = parseFeishuReceiveEvent(receiveEvent({ messageId: "om_group_plain", chatType: "group", text: "plain group message" }));
  const privateMessage = parseFeishuReceiveEvent(receiveEvent({ messageId: "om_private", chatType: "p2p", text: "private hello" }));
  assert.ok(groupMention);
  assert.ok(groupPlain);
  assert.ok(privateMessage);

  assert.equal(shouldAcceptFeishuInboundEvent(groupMention, inbound, "ou_bot"), true);
  assert.equal(shouldAcceptFeishuInboundEvent(groupMention, inbound, "ou_someone_else"), false);
  assert.equal(shouldAcceptFeishuInboundEvent(groupPlain, inbound, "ou_bot"), false);
  assert.equal(shouldAcceptFeishuInboundEvent(privateMessage, inbound, "ou_bot"), false);
  assert.equal(shouldAcceptFeishuInboundEvent(groupPlain, { ...inbound, groupMessageMode: "all" }, "ou_bot"), true);
  assert.equal(shouldAcceptFeishuInboundEvent(privateMessage, { ...inbound, allowedChatTypes: ["group", "p2p"] }, "ou_bot"), true);
});

test("project config renders Feishu platform defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suzumio-platform-config-"));
  try {
    const filePath = path.join(root, "project.yaml");
    await writeFile(filePath, `
name: platform-config
task: Test Feishu platform config.
backend:
  runner:
    mode: ai
    model: main
    models:
      providers:
        gateway:
          type: openai-compatible
          baseURLEnv: SUZUMIO_GATEWAY_BASE_URL
          apiKeyEnv: SUZUMIO_GATEWAY_API_KEY
      presets:
        main:
          provider: gateway
          model: gpt-5.5
agents:
  pm:
    model: main
    tools:
      - messages.send
platforms:
  - id: feishu-main
    kind: feishu
`, "utf8");
    const rendered = YAML.parse(await renderProjectConfig(filePath));
    assert.equal(rendered.platforms[0].id, "feishu-main");
    assert.equal(rendered.platforms[0].kind, "feishu");
    assert.equal(rendered.platforms[0].appIdEnv, "FEISHU_APP_ID");
    assert.equal(rendered.platforms[0].appSecretEnv, "FEISHU_APP_SECRET");
    assert.equal(rendered.platforms[0].inbound.recipient, "pm");
    assert.deepEqual(rendered.platforms[0].inbound.allowedChatTypes, ["group"]);
    assert.equal(rendered.platforms[0].inbound.groupMessageMode, "bot_mentions");
    assert.equal(rendered.platforms[0].inbound.botOpenIdEnv, "FEISHU_BOT_OPEN_ID");
    assert.equal(rendered.platforms[0].inbound.reactionAck.enabled, true);
    assert.equal(rendered.platforms[0].inbound.reactionAck.emojiType, "Typing");
    assert.equal(rendered.platforms[0].outbound.recipient, "user");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project config materializes scheduler defaults through the parser", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suzumio-scheduler-config-"));
  try {
    const filePath = path.join(root, "project.yaml");
    await writeFile(filePath, `
name: scheduler-config
task: Test scheduler config defaults.
backend:
  runner:
    mode: ai
    model: main
    models:
      providers:
        gateway:
          type: openai-compatible
          baseURLEnv: SUZUMIO_GATEWAY_BASE_URL
          apiKeyEnv: SUZUMIO_GATEWAY_API_KEY
      presets:
        main:
          provider: gateway
          model: gpt-5.5
agents:
  pm:
    model: main
    tools:
      - messages.send
`, "utf8");
    const loaded = await loadProjectConfig(filePath);
    assert.equal(loaded.config.scheduler.noEffectNudge.priority, "P3");
    assert.equal(loaded.config.scheduler.allQuietNudge.priority, "P3");
    assert.equal(loaded.config.scheduler.failedNudge.priority, "P2");
    assert.equal(loaded.config.scheduler.quietAgentMonitor.enabled, false);
    assert.equal(loaded.config.scheduler.failedAgentMonitor.enabled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function receiveEvent({ messageId, chatType, text, mentions = [] }) {
  return {
    schema: "2.0",
    header: {
      event_id: `${messageId}_event`,
      event_type: "im.message.receive_v1",
      tenant_key: "tenant",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender",
        },
        sender_type: "user",
        tenant_key: "tenant",
      },
      message: {
        message_id: messageId,
        chat_id: "oc_1",
        chat_type: chatType,
        message_type: "text",
        content: JSON.stringify({ text }),
        mentions,
      },
    },
  };
}
