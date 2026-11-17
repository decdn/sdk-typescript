import { describe, expect, it } from "vitest";
import { defaultDataDir } from "../../src/node.js";

describe("defaultDataDir", () => {
  it("is ~/.decdn/gateway", () => {
    expect(defaultDataDir()).toMatch(/[/\\]\.decdn[/\\]gateway$/);
  });
});
