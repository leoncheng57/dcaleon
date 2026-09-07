import { describe, expect, it } from "vitest";

import { splitProjectWorkspace } from "../client/lib/projectPath.js";

describe("splitProjectWorkspace", () => {
  it("returns just the project when there is no worktree marker", () => {
    expect(splitProjectWorkspace("dcaleon")).toEqual({ project: "dcaleon" });
  });

  it("splits a project and its worktree sibling", () => {
    expect(splitProjectWorkspace("dcaleon.worktrees/plan-build-toggle")).toEqual({
      project: "dcaleon",
      workspace: "plan-build-toggle",
    });
  });

  it("handles a nested workspace path", () => {
    expect(splitProjectWorkspace("dcaleon.worktrees/nested/deep")).toEqual({
      project: "dcaleon",
      workspace: "nested/deep",
    });
  });

  it("only splits on the first marker occurrence", () => {
    expect(splitProjectWorkspace("a.worktrees/b.worktrees/c")).toEqual({
      project: "a",
      workspace: "b.worktrees/c",
    });
  });
});
