import { describe, expect, test } from "bun:test";
import { anthropicToChatRequest } from "../src/bridge/anthropic-translate-request.ts";
import {
  chatChunkToAnthropicEvents,
  chatCompletionToAnthropicMessage,
  createAnthropicStreamState,
  forceCompleteAnthropicStream,
} from "../src/bridge/anthropic-translate-response.ts";
import { normalizeBridgeUpstreams } from "../src/bridge/state.ts";

describe("anthropic → chat request", () => {
  test("maps system, text, tools and tool results", () => {
    const chat = anthropicToChatRequest({
      model: "glm-5",
      max_tokens: 128,
      system: "You are helpful.",
      tools: [
        {
          name: "get_time",
          description: "time",
          input_schema: {
            type: "object",
            properties: { tz: { type: "string" } },
          },
        },
      ],
      tool_choice: { type: "any" },
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_time",
              input: { tz: "UTC" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "12:00",
            },
          ],
        },
      ],
    });

    expect(chat.model).toBe("glm-5");
    expect(chat.max_tokens).toBe(128);
    expect(chat.tool_choice).toBe("required");
    expect(chat.tools?.[0]?.function.name).toBe("get_time");
    expect(chat.messages[0]).toEqual({
      role: "system",
      content: "You are helpful.",
    });
    expect(chat.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(chat.messages[2]?.role).toBe("assistant");
    expect(chat.messages[2]?.tool_calls?.[0]?.id).toBe("toolu_1");
    expect(chat.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "toolu_1",
      content: "12:00",
    });
  });
});

describe("chat → anthropic response", () => {
  test("non-stream text + tool_use", () => {
    const msg = chatCompletionToAnthropicMessage(
      {
        id: "chatcmpl-1",
        model: "glm-5",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "ok",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_time",
                    arguments: '{"tz":"UTC"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      },
      "glm-5",
    );

    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content).toEqual([
      { type: "text", text: "ok" },
      {
        type: "tool_use",
        id: "call_1",
        name: "get_time",
        input: { tz: "UTC" },
      },
    ]);
  });

  test("stream emits anthropic SSE frames", () => {
    const state = createAnthropicStreamState("glm-5", "msg_test");
    const frames = [
      ...chatChunkToAnthropicEvents(
        {
          choices: [{ delta: { content: "He" } }],
        },
        state,
      ),
      ...chatChunkToAnthropicEvents(
        {
          choices: [{ delta: { content: "llo" }, finish_reason: "stop" }],
        },
        state,
      ),
      ...forceCompleteAnthropicStream(state),
    ].join("");

    expect(frames).toContain("event: message_start");
    expect(frames).toContain("event: content_block_delta");
    expect(frames).toContain('"text":"He"');
    expect(frames).toContain('"text":"llo"');
    expect(frames).toContain("event: message_delta");
    expect(frames).toContain('"stop_reason":"end_turn"');
    expect(frames).toContain("event: message_stop");
  });
});

describe("bridge upstream migration", () => {
  test("legacy single upstream becomes codex slot", () => {
    const legacy = {
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "k",
      mode: "chat",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(normalizeBridgeUpstreams(legacy)).toEqual({
      codex: legacy,
      claude: null,
    });
  });

  test("new dual format preserved", () => {
    const dual = {
      codex: {
        baseUrl: "http://a/v1",
        apiKey: "a",
        mode: "chat" as const,
        updatedAt: "t",
      },
      claude: {
        baseUrl: "http://b/v1",
        apiKey: "b",
        mode: "chat" as const,
        updatedAt: "t",
      },
    };
    expect(normalizeBridgeUpstreams(dual)).toEqual(dual);
  });
});
