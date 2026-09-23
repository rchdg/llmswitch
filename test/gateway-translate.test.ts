import { describe, expect, test } from "bun:test";
import {
  chatToAnthropicRequest,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
} from "../src/bridge/chat-to-anthropic-request.ts";
import {
  anthropicEventToChatChunks,
  anthropicMessageToChatCompletion,
  createAnthropicToChatStreamState,
  forceCompleteAnthropicToChatStream,
  parseAnthropicSseLine,
  AnthropicStreamError,
} from "../src/bridge/anthropic-to-chat-response.ts";
import { chatToResponsesRequest } from "../src/bridge/chat-to-responses-request.ts";
import {
  createResponsesToChatStreamState,
  forceCompleteResponsesToChatStream,
  responseToChatCompletion,
  responsesEventToChatChunks,
} from "../src/bridge/responses-to-chat-response.ts";
import { anthropicToChatRequest } from "../src/bridge/anthropic-translate-request.ts";
import { responsesToChatRequest } from "../src/bridge/translate-request.ts";

type Row = Record<string, unknown>;

function firstDelta(chunks: Row[]): Row {
  const choices = chunks
    .flatMap((chunk) => (Array.isArray(chunk.choices) ? chunk.choices : []))
    .map((choice) => (choice as Row).delta as Row)
    .filter(Boolean);
  return choices[0] ?? {};
}

function collectContent(chunks: Row[]): string {
  let text = "";
  for (const chunk of chunks) {
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      const delta = (choice as Row).delta as Row | undefined;
      if (delta && typeof delta.content === "string") text += delta.content;
    }
  }
  return text;
}

function collectToolArguments(chunks: Row[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const chunk of chunks) {
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      const delta = (choice as Row).delta as Row | undefined;
      const calls = Array.isArray(delta?.tool_calls) ? delta!.tool_calls : [];
      for (const raw of calls) {
        const call = raw as Row;
        const index = typeof call.index === "number" ? call.index : 0;
        const fn = call.function as Row | undefined;
        const args = typeof fn?.arguments === "string" ? fn.arguments : "";
        out.set(index, (out.get(index) ?? "") + args);
      }
    }
  }
  return out;
}

function finishReasons(chunks: Row[]): string[] {
  const out: string[] = [];
  for (const chunk of chunks) {
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      const reason = (choice as Row).finish_reason;
      if (typeof reason === "string") out.push(reason);
    }
  }
  return out;
}

describe("chat → anthropic request", () => {
  test("extracts system, merges roles, maps tools and tool results", () => {
    const body = chatToAnthropicRequest({
      model: "claude-sonnet-4",
      max_tokens: 256,
      temperature: 0.4,
      stop: ["STOP"],
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
        { role: "user", content: "again" },
        {
          role: "assistant",
          content: "calling",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_time", arguments: '{"tz":"UTC"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "12:00" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_time",
            description: "time",
            parameters: { type: "object", properties: { tz: { type: "string" } } },
          },
        },
      ],
      tool_choice: "required",
    });

    expect(body.system).toBe("be terse");
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.4);
    expect(body.stop_sequences).toEqual(["STOP"]);
    expect(body.tool_choice).toEqual({ type: "any" });

    const tools = body.tools as Row[];
    expect(tools[0]?.name).toBe("get_time");
    expect(tools[0]?.input_schema).toEqual({
      type: "object",
      properties: { tz: { type: "string" } },
    });

    const messages = body.messages as Array<{ role: string; content: Row[] }>;
    // The two consecutive user turns are merged into one.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "again" },
    ]);
    expect(messages[1]?.content[1]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "get_time",
      input: { tz: "UTC" },
    });
    expect(messages[2]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_1",
      content: "12:00",
    });
  });

  test("applies a default max_tokens because anthropic requires it", () => {
    const body = chatToAnthropicRequest({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.max_tokens).toBe(DEFAULT_ANTHROPIC_MAX_TOKENS);
  });

  test("converts data-url and http images into anthropic image blocks", () => {
    const body = chatToAnthropicRequest({
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
            { type: "image_url", image_url: { url: "https://x.test/a.png" } },
          ],
        },
      ],
    });
    const blocks = (body.messages as Array<{ content: Row[] }>)[0]!.content;
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    expect(blocks[2]).toEqual({
      type: "image",
      source: { type: "url", url: "https://x.test/a.png" },
    });
  });

  test("converts chat file parts into anthropic document blocks", () => {
    const body = chatToAnthropicRequest({
      model: "claude-sonnet-4",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "总结" },
            {
              type: "file",
              file: {
                filename: "doc.pdf",
                file_data: "data:application/pdf;base64,JVBERi0=",
              },
            },
            { type: "file", file: { file_id: "file-abc" } },
          ],
        },
      ],
    });
    const blocks = (body.messages as Array<{ content: Row[] }>)[0]!.content;
    expect(blocks[1]).toEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0=",
      },
      title: "doc.pdf",
    });
    // file_id 引用没有 Anthropic 等价物，跳过而不是报错
    expect(blocks).toHaveLength(2);
  });

  test("round-trips back through the anthropic → chat translator", () => {
    const original = {
      model: "m",
      max_tokens: 64,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "question" },
      ],
    };
    const roundTripped = anthropicToChatRequest(
      chatToAnthropicRequest(original),
    );
    expect(roundTripped.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(roundTripped.messages[1]).toEqual({
      role: "user",
      content: "question",
    });
    expect(roundTripped.max_tokens).toBe(64);
  });
});

describe("anthropic → chat response", () => {
  test("maps content blocks, tool_use and usage", () => {
    const chat = anthropicMessageToChatCompletion(
      {
        id: "msg_123",
        model: "claude-sonnet-4",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hello" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_time",
            input: { tz: "UTC" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 4 },
      },
      "fallback",
    );

    const choice = (chat.choices as Row[])[0] as Row;
    const message = choice.message as Row;
    expect(chat.id).toBe("chatcmpl-123");
    expect(chat.model).toBe("claude-sonnet-4");
    expect(message.content).toBe("hello");
    expect(message.reasoning_content).toBe("hmm");
    expect(choice.finish_reason).toBe("tool_calls");
    const calls = message.tool_calls as Row[];
    expect((calls[0]?.function as Row).name).toBe("get_time");
    expect((calls[0]?.function as Row).arguments).toBe('{"tz":"UTC"}');
    expect(chat.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
    });
  });

  test("streams text and tool arguments into chat chunks", () => {
    const state = createAnthropicToChatStreamState("claude-sonnet-4");
    const events: Row[] = [
      {
        type: "message_start",
        message: {
          id: "msg_9",
          model: "claude-sonnet-4",
          usage: { input_tokens: 7, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "lo" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_2", name: "search" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"q":' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"x"}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 12 },
      },
      { type: "message_stop" },
    ];

    const chunks = events.flatMap((event) =>
      anthropicEventToChatChunks(event, state),
    );

    expect(firstDelta(chunks).role).toBe("assistant");
    expect(collectContent(chunks)).toBe("Hello");
    expect(collectToolArguments(chunks).get(0)).toBe('{"q":"x"}');
    expect(finishReasons(chunks)).toEqual(["tool_calls"]);

    const usageChunk = chunks[chunks.length - 1] as Row;
    expect(usageChunk.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 12,
      total_tokens: 19,
    });
    // message_stop already finalised the stream.
    expect(forceCompleteAnthropicToChatStream(state)).toEqual([]);
  });

  test("force-completes a truncated stream", () => {
    const state = createAnthropicToChatStreamState("m");
    anthropicEventToChatChunks(
      { type: "message_start", message: { id: "msg_1", model: "m" } },
      state,
    );
    const tail = forceCompleteAnthropicToChatStream(state);
    expect(finishReasons(tail)).toEqual(["stop"]);
  });

  test("throws on upstream error events", () => {
    const state = createAnthropicToChatStreamState("m");
    expect(() =>
      anthropicEventToChatChunks(
        {
          type: "error",
          error: { type: "overloaded_error", message: "busy" },
        },
        state,
      ),
    ).toThrow(AnthropicStreamError);
  });

  test("parses sse data lines", () => {
    expect(parseAnthropicSseLine("event: message_stop")).toBeNull();
    expect(parseAnthropicSseLine('data: {"type":"ping"}')).toEqual({
      type: "ping",
    });
    expect(parseAnthropicSseLine("data: [DONE]")).toBe("done");
  });
});

describe("chat → responses request", () => {
  test("maps instructions, input items, tools and token limits", () => {
    const body = chatToResponsesRequest({
      model: "gpt-5",
      max_completion_tokens: 512,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_7",
              type: "function",
              function: { name: "lookup", arguments: '{"a":1}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_7", content: "done" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
      tool_choice: { type: "function", function: { name: "lookup" } },
    });

    expect(body.instructions).toBe("sys");
    expect(body.max_output_tokens).toBe(512);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.store).toBe(false);
    expect(body.tool_choice).toEqual({ type: "function", name: "lookup" });
    expect((body.tools as Row[])[0]?.name).toBe("lookup");

    const input = body.input as Row[];
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    });
    expect(input[1]).toEqual({
      type: "function_call",
      call_id: "call_7",
      name: "lookup",
      arguments: '{"a":1}',
    });
    expect(input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_7",
      output: "done",
    });
  });

  test("round-trips back through the responses → chat translator", () => {
    const roundTripped = responsesToChatRequest(
      chatToResponsesRequest({
        model: "m",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "ask" },
        ],
      }),
    );
    expect(roundTripped.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(roundTripped.messages[1]).toEqual({ role: "user", content: "ask" });
  });
});

describe("responses → chat response", () => {
  test("maps output items and usage", () => {
    const chat = responseToChatCompletion(
      {
        id: "resp_5",
        model: "gpt-5",
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ text: "think" }] },
          {
            type: "message",
            content: [{ type: "output_text", text: "answer" }],
          },
          {
            type: "function_call",
            call_id: "call_2",
            name: "run",
            arguments: '{"x":2}',
          },
        ],
        usage: {
          input_tokens: 3,
          output_tokens: 9,
          total_tokens: 12,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
      "fallback",
    );

    const choice = (chat.choices as Row[])[0] as Row;
    const message = choice.message as Row;
    expect(chat.id).toBe("chatcmpl-5");
    expect(message.content).toBe("answer");
    expect(message.reasoning_content).toBe("think");
    expect(choice.finish_reason).toBe("tool_calls");
    expect(chat.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 9,
      total_tokens: 12,
      completion_tokens_details: { reasoning_tokens: 5 },
    });
  });

  test("maps incomplete responses to finish_reason length", () => {
    const chat = responseToChatCompletion({
      id: "resp_6",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }],
    });
    expect(((chat.choices as Row[])[0] as Row).finish_reason).toBe("length");
  });

  test("streams text and function arguments into chat chunks", () => {
    const state = createResponsesToChatStreamState("gpt-5");
    const events: Row[] = [
      {
        type: "response.created",
        response: { id: "resp_7", model: "gpt-5" },
      },
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_3",
          name: "run",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"x":',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: "1}",
      },
      {
        type: "response.completed",
        response: {
          id: "resp_7",
          model: "gpt-5",
          status: "completed",
          usage: { input_tokens: 2, output_tokens: 6 },
        },
      },
    ];

    const chunks = events.flatMap((event) =>
      responsesEventToChatChunks(event, state),
    );

    expect(firstDelta(chunks).role).toBe("assistant");
    expect(collectContent(chunks)).toBe("Hello");
    expect(collectToolArguments(chunks).get(0)).toBe('{"x":1}');
    expect(finishReasons(chunks)).toEqual(["tool_calls"]);
    expect((chunks[chunks.length - 1] as Row).usage).toEqual({
      prompt_tokens: 2,
      completion_tokens: 6,
      total_tokens: 8,
    });
  });

  test("emits custom tool input as json arguments", () => {
    const state = createResponsesToChatStreamState("gpt-5");
    responsesEventToChatChunks(
      {
        type: "response.output_item.added",
        item: {
          id: "ctc_1",
          type: "custom_tool_call",
          call_id: "call_9",
          name: "shell",
        },
      },
      state,
    );
    responsesEventToChatChunks(
      {
        type: "response.custom_tool_call_input.delta",
        item_id: "ctc_1",
        delta: "ls -la",
      },
      state,
    );
    const done = responsesEventToChatChunks(
      {
        type: "response.custom_tool_call_input.done",
        item_id: "ctc_1",
        input: "ls -la",
      },
      state,
    );
    expect(collectToolArguments(done).get(0)).toBe('{"input":"ls -la"}');
  });

  test("force-completes a truncated stream", () => {
    const state = createResponsesToChatStreamState("m");
    responsesEventToChatChunks(
      { type: "response.created", response: { id: "resp_8", model: "m" } },
      state,
    );
    expect(finishReasons(forceCompleteResponsesToChatStream(state))).toEqual([
      "stop",
    ]);
  });
});
