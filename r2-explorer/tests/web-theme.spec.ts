import { afterEach, describe, expect, it, vi } from "vitest";
import { readTheme } from "../web/src/lib/theme";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readTheme", () => {
  it("returns dark when document is unavailable (SSR)", () => {
    expect(readTheme()).toBe("dark");
  });

  it("reflects a light data-theme already applied to the DOM", () => {
    vi.stubGlobal("document", { documentElement: { dataset: { theme: "light" } } });
    expect(readTheme()).toBe("light");
  });

  it("treats any non-light value as dark", () => {
    vi.stubGlobal("document", { documentElement: { dataset: { theme: "dark" } } });
    expect(readTheme()).toBe("dark");
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    expect(readTheme()).toBe("dark");
  });
});
