import {
  displayWidth,
  padEndDisplay,
  padStartDisplay,
  renderTable,
} from "../src/utils/display.ts";

describe("displayWidth", () => {
  test("CJK characters count as two columns", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("请求数")).toBe(6);
    expect(displayWidth("输入 tokens")).toBe(11);
    expect(displayWidth("深度求索")).toBe(8);
  });

  test("fullwidth punctuation and kana count as two", () => {
    expect(displayWidth("（）")).toBe(4);
    expect(displayWidth("ひらがな")).toBe(8);
    expect(displayWidth("한글")).toBe(4);
  });

  test("zero-width and combining marks count as zero", () => {
    expect(displayWidth("a\u200bb")).toBe(2);
    expect(displayWidth("e\u0301")).toBe(1);
  });
});

describe("display padding", () => {
  test("pads by rendered width, not code units", () => {
    // "供应商" 占 6 列；padEnd(8) 只会补 5 个空格，padEndDisplay 补 2 个
    expect(padEndDisplay("供应商", 8)).toBe("供应商  ");
    expect(displayWidth(padEndDisplay("供应商", 8))).toBe(8);
    expect(displayWidth(padStartDisplay("模型", 6))).toBe(6);
  });

  test("never truncates when the value is wider than the target", () => {
    expect(padEndDisplay("abcdef", 3)).toBe("abcdef");
  });
});

describe("renderTable", () => {
  test("every data row has the same rendered width even with CJK cells", () => {
    const rows = [
      { day: "2026-09-14", requests: 12, provider: "深度求索", model: "deepseek-chat" },
      { day: "2026-09-13", requests: 3, provider: "openrouter", model: "openai/gpt-4o" },
    ];
    const lines = renderTable(rows, [
      { header: "日期", value: (r) => r.day },
      { header: "请求数", value: (r) => String(r.requests), align: "right" },
      { header: "供应商", value: (r) => r.provider },
      { header: "模型", value: (r) => r.model },
    ]);
    expect(lines).toHaveLength(3);
    const dataWidths = lines.slice(1).map(displayWidth);
    expect(new Set(dataWidths).size).toBe(1);
  });

  test("right-aligned numeric columns line up on their last digit", () => {
    const lines = renderTable(
      [{ n: 5 }, { n: 12345 }],
      [{ header: "n", value: (r) => String(r.n), align: "right" }],
    );
    expect(lines[1]).toBe("    5");
    expect(lines[2]).toBe("12345");
  });
});
