import { describe, expect, test } from "bun:test";
import {
  collectCustomToolNames,
  mapResponsesTools,
  responsesToChatRequest,
} from "../src/bridge/translate-request.ts";
import {
  chatChunkToResponsesEvents,
  chatCompletionToResponse,
  createStreamState,
  forceCompleteStream,
  parseChatSseLine,
  unwrapCustomToolInput,
} from "../src/bridge/translate-response.ts";

function parseResponseFrames(frames: string[]): Array<Record<string, unknown>> {
  return frames
    .join("")
    .split(/\n\n/)
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

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

  test("maps custom_tool_call history and freeform tools", () => {
    const chat = responsesToChatRequest({
      model: "m",
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_p",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_p",
          output: "ok",
        },
      ],
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          description: "Freeform patch tool",
        },
        { type: "web_search", external_web_access: true },
      ],
    });

    expect(chat.messages[0]?.tool_calls?.[0]).toEqual({
      id: "call_p",
      type: "function",
      function: {
        name: "apply_patch",
        arguments: JSON.stringify({
          input: "*** Begin Patch\n*** End Patch",
        }),
      },
    });
    expect(chat.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call_p",
      content: "ok",
    });
    expect(chat.tools?.map((t) => t.function.name).sort()).toEqual([
      "apply_patch",
      "web_search",
    ]);
  });
  test("keeps input_image parts when translating to chat content", () => {
    // Regression: Codex 附加图片（view_image / @file）时图片被静默丢弃，
    // 上游模型完全收不到图。
    const url = "data:image/png;base64,iVBORw0KGgo=";
    const chat = responsesToChatRequest({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "看这张图" },
            { type: "input_image", image_url: url, detail: "high" },
          ],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: url }],
        },
      ],
    });

    const first = chat.messages[0]?.content as Array<Record<string, unknown>>;
    expect(first).toEqual([
      { type: "text", text: "看这张图" },
      { type: "image_url", image_url: { url, detail: "high" } },
    ]);
    // 图片-only 消息不能退化为空字符串 content
    const second = chat.messages[1]?.content as Array<Record<string, unknown>>;
    expect(second).toEqual([
      { type: "image_url", image_url: { url } },
    ]);
  });

  test("joins plain text messages into a string like before", () => {
    const chat = responsesToChatRequest({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "a" },
            { type: "input_text", text: "b" },
          ],
        },
      ],
    });
    expect(chat.messages[0]?.content).toBe("ab");
  });
});

describe("mapResponsesTools / collectCustomToolNames", () => {
  test("keeps custom names and maps hosted tools", () => {
    const tools = [
      { type: "web_search" },
      {
        type: "tool_search",
        description: "find tools",
        parameters: { type: "object" },
      },
      { type: "custom", name: "apply_patch", description: "patch" },
      { type: "namespace", name: "browser" },
    ];
    const mapped = mapResponsesTools(tools);
    expect(mapped?.map((t) => t.function.name).sort()).toEqual([
      "apply_patch",
      "tool_search",
      "web_search",
    ]);
    expect([...collectCustomToolNames(tools)]).toEqual(["apply_patch"]);
  });
});

describe("reasoning_content passthrough (chat → responses)", () => {
  // Regression: the chat→responses direction dropped reasoning entirely, so
  // Codex never saw the chain of thought from reasoning models.
  test("non-streaming reasoning_content becomes a reasoning output item", () => {
    const resp = chatCompletionToResponse({
      model: "deepseek-reasoner",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            reasoning_content: "先分解问题",
            content: "答案是 4",
          },
          finish_reason: "stop",
        },
      ],
    });
    const output = resp.output as Array<Record<string, unknown>>;
    const reasoning = output.find((item) => item.type === "reasoning");
    expect(reasoning).toBeDefined();
    expect(
      (reasoning!.summary as Array<{ text: string }>)[0]!.text,
    ).toBe("先分解问题");
    // reasoning 必须排在正文 message 之前
    expect(output.findIndex((i) => i.type === "reasoning")).toBeLessThan(
      output.findIndex((i) => i.type === "message"),
    );
  });

  test("streaming reasoning_content emits summary delta then closes before text", () => {
    const state = createStreamState("m");
    const frames = [
      ...chatChunkToResponsesEvents(
        { choices: [{ delta: { reasoning_content: "想一下" }, index: 0 }] },
        state,
      ),
      ...chatChunkToResponsesEvents(
        { choices: [{ delta: { content: "好" }, index: 0 }] },
        state,
      ),
      ...chatChunkToResponsesEvents(
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
        state,
      ),
    ].join("");

    expect(frames).toContain("response.reasoning_summary_text.delta");
    expect(frames).toContain("想一下");
    expect(frames).toContain("response.reasoning_summary_text.done");
    // reasoning 项要在正文 output_text 开始前收尾
    expect(frames.indexOf("response.reasoning_summary_text.done")).toBeLessThan(
      frames.indexOf("response.output_text.delta"),
    );
    expect(frames).toContain("response.completed");
  });

  test("reasoning-only reply still closes the reasoning item", () => {
    const state = createStreamState("m");
    const frames = [
      ...chatChunkToResponsesEvents(
        { choices: [{ delta: { reasoning_content: "只有推理" }, index: 0 }] },
        state,
      ),
      ...chatChunkToResponsesEvents(
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
        state,
      ),
    ].join("");
    expect(frames).toContain("response.reasoning_summary_text.done");
    expect(frames).toContain('"type":"reasoning"');
    expect(frames).toContain("response.completed");
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

  test("emits custom_tool_call for freeform tools and unique output_index", () => {
    const state = createStreamState("m", undefined, ["apply_patch"]);
    const frames = [
      ...chatChunkToResponsesEvents(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "apply_patch", arguments: "" },
                  },
                ],
              },
              index: 0,
            },
          ],
        },
        state,
      ),
      ...chatChunkToResponsesEvents(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments:
                        "{\"input\":\"*** Begin Patch\\n*** End Patch\"}",
                    },
                  },
                ],
              },
              index: 0,
            },
          ],
        },
        state,
      ),
      ...chatChunkToResponsesEvents(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: "call_2",
                    function: {
                      name: "exec_command",
                      arguments: "{\"cmd\":\"ls\"}",
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
              index: 0,
            },
          ],
        },
        state,
      ),
    ].join("");

    expect(frames).toContain('"type":"custom_tool_call"');
    expect(frames).toContain("response.custom_tool_call_input.done");
    expect(frames).toContain("*** Begin Patch");
    expect(frames).toContain('"type":"function_call"');
    expect(frames).toContain('"output_index":0');
    expect(frames).toContain('"output_index":1');
    expect(unwrapCustomToolInput('{"input":"raw"}')).toBe("raw");
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

  test("non-stream custom tool conversion", () => {
    const resp = chatCompletionToResponse(
      {
        model: "m",
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_x",
                  type: "function",
                  function: {
                    name: "apply_patch",
                    arguments: '{"input":"*** Begin Patch"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "m",
      ["apply_patch"],
    );
    const output = resp.output as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      input: "*** Begin Patch",
      call_id: "call_x",
    });
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

  test("converts split web search markup and preserves output order", () => {
    const state = createStreamState("m", "resp_test", undefined, true);
    const frames = [
      ...chatChunkToResponsesEvents(
        { choices: [{ delta: { content: "Before <web_" }, index: 0 }] },
        state,
      ),
      ...chatChunkToResponsesEvents(
        {
          choices: [
            {
              delta: {
                content: 'search>\nSearch results for “Tokyo weather”:\n1. Sunny</web_',
              },
              index: 0,
            },
          ],
        },
        state,
      ),
      ...chatChunkToResponsesEvents(
        {
          choices: [
            {
              delta: { content: "search> After" },
              finish_reason: "stop",
              index: 0,
            },
          ],
        },
        state,
      ),
    ];
    const events = parseResponseFrames(frames);
    const done = events.filter(
      (event) => event.type === "response.output_item.done",
    );
    const doneItems = done.map(
      (event) => event.item as Record<string, unknown>,
    );

    expect(doneItems.map((item) => item.type)).toEqual([
      "message",
      "web_search_call",
      "message",
      "message",
    ]);
    expect(doneItems[0]?.content).toEqual([
      { type: "output_text", text: "Before ", annotations: [] },
    ]);
    expect(doneItems[1]?.action).toEqual({
      type: "search",
      query: "Tokyo weather",
    });
    expect(doneItems[2]?.content).toEqual([
      {
        type: "output_text",
        text: "\nSearch results for “Tokyo weather”:\n1. Sunny",
        annotations: [],
      },
    ]);
    expect(doneItems[3]?.content).toEqual([
      { type: "output_text", text: " After", annotations: [] },
    ]);

    const completed = events.find(
      (event) => event.type === "response.completed",
    );
    const response = completed?.response as Record<string, unknown>;
    const output = response.output as Array<Record<string, unknown>>;
    expect(output).toEqual(doneItems);
    expect(frames.join("")).not.toContain("<web_search>");
    expect(frames.join("")).not.toContain("</web_search>");
  });

  test("converts multiple web searches and omits empty result messages", () => {
    const state = createStreamState("m", undefined, undefined, true);
    const frames = chatChunkToResponsesEvents(
      {
        choices: [
          {
            delta: {
              content:
                '<web_search>Search results for "one":\nA</web_search><web_search></web_search>',
            },
            finish_reason: "stop",
            index: 0,
          },
        ],
      },
      state,
    );
    const doneItems = parseResponseFrames(frames)
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => event.item as Record<string, unknown>);

    expect(doneItems.map((item) => item.type)).toEqual([
      "web_search_call",
      "message",
      "web_search_call",
    ]);
    expect(new Set(doneItems.map((item) => item.id)).size).toBe(3);
    expect(doneItems[2]?.action).toEqual({ type: "search" });
  });

  test("falls back to text for incomplete or explicitly disabled web search markup", () => {
    const incompleteState = createStreamState("m", undefined, undefined, true);
    const incompleteFrames = chatChunkToResponsesEvents(
      {
        choices: [
          {
            delta: { content: "prefix <web_search>unfinished" },
            index: 0,
          },
        ],
      },
      incompleteState,
    );
    incompleteFrames.push(...forceCompleteStream(incompleteState));
    const incompleteText = parseResponseFrames(incompleteFrames)
      .filter((event) => event.type === "response.output_item.done")
      .flatMap((event) => {
        const item = event.item as Record<string, unknown>;
        return item.type === "message"
          ? (item.content as Array<{ text: string }>).map((part) => part.text)
          : [];
      })
      .join("");
    expect(incompleteText).toBe("prefix <web_search>unfinished");

    const disabledState = createStreamState("m");
    const disabledFrames = chatChunkToResponsesEvents(
      {
        choices: [
          {
            delta: { content: "<web_search>raw</web_search>" },
            finish_reason: "stop",
            index: 0,
          },
        ],
      },
      disabledState,
    );
    expect(disabledFrames.join("")).toContain(
      "<web_search>raw</web_search>",
    );
    expect(disabledFrames.join("")).not.toContain("web_search_call");
  });

  test("non-stream conversion emits web search and cleaned result message", () => {
    const resp = chatCompletionToResponse(
      {
        model: "m",
        choices: [
          {
            message: {
              role: "assistant",
              content:
                'Intro<web_search>Search results for "Bun":\nresult</web_search>Outro',
            },
            finish_reason: "stop",
          },
        ],
      },
      "m",
      undefined,
      true,
    );
    const output = resp.output as Array<Record<string, unknown>>;

    expect(output.map((item) => item.type)).toEqual([
      "message",
      "web_search_call",
      "message",
      "message",
    ]);
    expect(output[1]?.action).toEqual({ type: "search", query: "Bun" });
    expect(JSON.stringify(output)).not.toContain("<web_search>");
  });
});
