import { describe, expect, it } from "vitest";

import { todoPriorityKind, todoStatusKind, todoSummary, TODO_STATUS_LABEL } from "../client/lib/todoView.js";

describe("todoStatusKind", () => {
  it("maps known statuses and aliases", () => {
    expect(todoStatusKind("completed")).toBe("completed");
    expect(todoStatusKind("Done")).toBe("completed");
    expect(todoStatusKind("in_progress")).toBe("in_progress");
    expect(todoStatusKind("in-progress")).toBe("in_progress");
    expect(todoStatusKind("cancelled")).toBe("cancelled");
    expect(todoStatusKind("canceled")).toBe("cancelled");
  });

  it("treats unknown statuses as pending", () => {
    expect(todoStatusKind("pending")).toBe("pending");
    expect(todoStatusKind("something-new")).toBe("pending");
    expect(todoStatusKind("")).toBe("pending");
  });

  it("has a label for every kind", () => {
    expect(Object.keys(TODO_STATUS_LABEL).sort()).toEqual(["cancelled", "completed", "in_progress", "pending"]);
  });
});

describe("todoPriorityKind", () => {
  it("keeps high and medium, defaults everything else to low", () => {
    expect(todoPriorityKind("HIGH")).toBe("high");
    expect(todoPriorityKind("medium")).toBe("medium");
    expect(todoPriorityKind("low")).toBe("low");
    expect(todoPriorityKind("urgent")).toBe("low");
  });
});

describe("todoSummary", () => {
  it("counts statuses and excludes cancelled items from the percentage", () => {
    const summary = todoSummary([
      { content: "a", status: "completed", priority: "high" },
      { content: "b", status: "in_progress", priority: "medium" },
      { content: "c", status: "pending", priority: "low" },
      { content: "d", status: "cancelled", priority: "low" },
    ]);
    expect(summary).toMatchObject({ completed: 1, in_progress: 1, pending: 1, cancelled: 1, total: 4, active: 3, percent: 33 });
  });

  it("is zero for an empty or fully cancelled list", () => {
    expect(todoSummary([]).percent).toBe(0);
    expect(todoSummary([{ content: "x", status: "cancelled", priority: "low" }]).percent).toBe(0);
  });
});
