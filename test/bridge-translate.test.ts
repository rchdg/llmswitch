import { describe, expect, test } from "bun:test";
import { responsesToChatRequest } from "../src/bridge/translate-request.ts";
import {
  chatChunkToResponsesEvents,
  chatCompletionToResponse,
  createStreamState,
  forceCompleteStream,
  parseChatSseLine,
} from "../src/bridge/translate-response.ts";

describe("responsesToChatRequest", () => {
  test("maps instructions, messages, tools and function outputs", () => {
    const chat = responsesToChatRequest({
      model: "glm-5.2",
      stream: true,
      instructions: "You are helpful",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "shell",
          arguments: "{\"cmd\":\"ls\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "a.txt",
        },
      ],
      tools: [
        {
          type: "function",
          name: "shell",
          description: "run",
          parameters: { type: "object" },
        },
      ],
      max_output_tokens: 100,
    });

    expect(chat.model).toBe("glm-5.2");
    expect(chat.stream).toBe(true);
    expect(chat.messages[0]).toEqual({
      role: "system",
      content: "You are helpful",
    });
    expect(chat.messages[1]?.role).toBe("user");
    expect(chat.messages[2]?.role).toBe("assistant");
    expect(chat.messages[2]?.tool_calls?.[0]?.id).toBe("call_1");
    expect(chat.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "a.txt",
    });
    expect(chat.tools?.[0]?.function.name).toBe("shell");
    expect(chat.max_tokens).toBe(100);
  });
});

describe("chat stream → responses events", () => {
  test("emits text deltas and completed", () => {
    const state = createStreamState("m");
    const frames1 = chatChunkToResponsesEvents(
      {
        choices: [{ delta: { content: "Hel" }, index: 0 }],
      },
      state,
    );
    const frames2 = chatChunkToResponsesEvents(
      {
        choices: [{ delta: { content: "lo" }, finish_reason: "stop", index: 0 }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
      state,
    );
    const all = [...frames1, ...frames2].join("");
    expect(all).toContain("response.created");
    expect(all).toContain("response.output_text.delta");
    expect(all).toContain("Hel");
    expect(all).toContain("lo");
    expect(all).toContain("response.completed");
  });

  test("parseChatSseLine", () => {
    expect(parseChatSseLine("data: [DONE]")).toBe("done");
    expect(parseChatSseLine('data: {"a":1}')).toEqual({ a: 1 });
  });

  test("non-stream conversion", () => {
    const resp = chatCompletionToResponse({
      model: "m",
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    expect(resp.object).toBe("response");
    expect(resp.status).toBe("completed");
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output[0]?.type).toBe("message");
  });

  test("forceComplete when upstream ends without finish_reason", () => {
    const state = createStreamState("m");
    chatChunkToResponsesEvents(
      { choices: [{ delta: { content: "x" }, index: 0 }] },
      state,
    );
    const end = forceCompleteStream(state).join("");
    expect(end).toContain("response.completed");
  });
});
