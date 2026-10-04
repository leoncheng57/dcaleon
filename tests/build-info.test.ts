import { describe, expect, it } from "vitest";

import { formatBuildLabel, formatBuildTitle } from "../client/lib/buildInfo.js";

describe("formatBuildLabel", () => {
  it("shows only the semantic version", () => {
    expect(formatBuildLabel("1.2.3")).toBe("v1.2.3");
  });

  it("keeps a prerelease suffix", () => {
    expect(formatBuildLabel("1.2.3-rc.1")).toBe("v1.2.3-rc.1");
  });
});

describe("formatBuildTitle", () => {
  it("keeps the deployed commit in the tooltip", () => {
    expect(formatBuildTitle("1.2.3", "abcdef0")).toBe("DCA v1.2.3 (abcdef0)");
  });

  it("omits the commit when git metadata is unavailable", () => {
    expect(formatBuildTitle("1.2.3", "")).toBe("DCA v1.2.3");
  });
});
