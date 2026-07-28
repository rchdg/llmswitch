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
});
