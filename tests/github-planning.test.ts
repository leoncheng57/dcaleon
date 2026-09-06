import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPlanningIssue,
  getPlanningItemDetails,
  getPlanningLabels,
  getPlanningSnapshot,
  normalizePlanningItem,
  PLANNING_LIMITS,
  planningErrorMessage,
  resetPlanningCache,
  updatePlanningItemLabels,
  validateCreatePlanningIssue,
  validatePlanningLabels,
  validatePlanningNumber,
  validateUpdatePlanningLabels,
} from "../server/github-planning.js";

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function rawItem(number: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: number,
    number,
    title: `Item ${number}`,
    state: "open",
    labels: [],
    user: { login: "octocat" },
    html_url: `https://github.com/leoncheng57/dcaleon/issues/${number}`,
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-21T11:30:00Z",
    comments: 3,
    sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
    ...extra,
  };
}

/** A parent as the list endpoint reports it: a count, and never a link. */
function rawEpic(number: number, total: number, completed = 0): Record<string, unknown> {
  return rawItem(number, { sub_issues_summary: { total, completed, percent_completed: 0 } });
}

function subIssuesPath(input: URL | RequestInfo): number | null {
  const match = String(input).match(/\/issues\/(\d+)\/sub_issues/u);
  return match ? Number(match[1]) : null;
}

afterEach(() => {
  resetPlanningCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GitHub planning normalization", () => {
  it("classifies issues and pull requests and keeps only label names", () => {
    expect(normalizePlanningItem(rawItem(1, {
      labels: [{ name: "frontend", color: "ff0000" }, "priority"],
    }))).toEqual(expect.objectContaining({
      number: 1,
      type: "issue",
      labels: ["frontend", "priority"],
      author: "octocat",
      createdAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-08-21T11:30:00Z",
      commentCount: 3,
    }));

    expect(normalizePlanningItem(rawItem(2, {
      state: "closed",
      pull_request: { merged_at: "2026-08-20T12:00:00Z" },
    }))).toEqual(expect.objectContaining({
      type: "pull_request",
      state: "closed",
      merged: true,
    }));
  });

  it("rejects records without a positive issue number and bounds external text", () => {
    expect(normalizePlanningItem(rawItem(0))).toBeNull();
    const normalized = normalizePlanningItem(rawItem(3, {
      title: "x".repeat(PLANNING_LIMITS.titleCharacters + 10),
      labels: Array.from({ length: PLANNING_LIMITS.labels + 5 }, (_, index) => ({ name: `label-${index}` })),
      html_url: "javascript:alert(1)",
    }));
    expect(normalized?.title).toHaveLength(PLANNING_LIMITS.titleCharacters);
    expect(normalized?.labels).toHaveLength(PLANNING_LIMITS.labels);
    expect(normalized?.url).toBe("");
  });

  it("reads the sub-issue summary defensively and never resolves a parent on its own", () => {
    expect(normalizePlanningItem(rawEpic(1, 4, 1))).toMatchObject({
      childCount: 4,
      completedChildCount: 1,
      parentNumber: null,
    });

    // A parent link only ever exists on the single-issue endpoint, and the
    // snapshot fan-out is the only thing allowed to fill it in.
    expect(normalizePlanningItem(rawItem(2, {
      sub_issues_summary: { total: 3, completed: 1 },
      parent_issue_url: "https://api.github.com/repos/leoncheng57/dcaleon/issues/9",
    }))?.parentNumber).toBeNull();

    for (const summary of [
      undefined,
      null,
      "3",
      [],
      {},
      { total: -2, completed: -1 },
      { total: 1.5, completed: 0.5 },
      { total: "many", completed: "some" },
      { total: Number.NaN, completed: Number.POSITIVE_INFINITY },
      { total: Number.MAX_SAFE_INTEGER + 1, completed: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(normalizePlanningItem(rawItem(3, { sub_issues_summary: summary })))
        .toMatchObject({ childCount: 0, completedChildCount: 0 });
    }
  });

  it("clamps a completed count that exceeds the total", () => {
    expect(normalizePlanningItem(rawEpic(1, 2, 9))).toMatchObject({ childCount: 2, completedChildCount: 2 });
    expect(normalizePlanningItem(rawItem(2, { sub_issues_summary: { total: 0, completed: 5 } })))
      .toMatchObject({ childCount: 0, completedChildCount: 0 });
  });
});

describe("GitHub planning fetch", () => {
  it("uses the fixed repository and bounds pagination with an explicit truncation flag", async () => {
    const fetchMock = vi.fn(async () => response(
      Array.from({ length: PLANNING_LIMITS.perPage }, (_, index) => rawItem(index + 1)),
      200,
      { Link: '<https://api.github.com/next>; rel="next"' },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPlanningSnapshot();

    expect(fetchMock).toHaveBeenCalledTimes(PLANNING_LIMITS.pages);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/repos/leoncheng57/dcaleon/issues");
    expect(String(fetchMock.mock.calls[0][0])).toContain("state=all");
    expect(snapshot.items).toHaveLength(PLANNING_LIMITS.pages * PLANNING_LIMITS.perPage);
    expect(snapshot.truncated).toBe(true);
  });

  it("stops on a short page and sends the token only from the server", async () => {
    vi.stubEnv("GITHUB_TOKEN", "server-secret");
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-secret");
      return response([rawItem(1)]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPlanningSnapshot();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(snapshot.truncated).toBe(false);
  });

  it.each([
    [401, {}, "Authentication unavailable"],
    [403, {}, "Authentication unavailable"],
    [403, { "X-RateLimit-Remaining": "0" }, "Rate limited"],
    [429, {}, "Rate limited"],
    [500, {}, "Unavailable"],
  ] as const)("sanitizes HTTP %s without leaking the token or response body", async (status, headers, expected) => {
    vi.stubEnv("GITHUB_TOKEN", "must-never-leak");
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "upstream-secret-detail" }, status, headers)));

    const error = await getPlanningSnapshot().catch((reason: unknown) => reason);

    expect(planningErrorMessage(error)).toBe(expected);
    expect(String(error)).not.toContain("must-never-leak");
    expect(String(error)).not.toContain("upstream-secret-detail");
  });

  it("coalesces concurrent requests and caches the successful snapshot", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = getPlanningSnapshot();
    const second = getPlanningSnapshot();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(response([rawItem(1)]));

    const [a, b] = await Promise.all([first, second]);
    const cached = await getPlanningSnapshot();
    expect(a).toBe(b);
    expect(cached).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub planning epic fan-out", () => {
  it("makes no extra request when nothing reports sub-issues", async () => {
    const fetchMock = vi.fn(async () => response([rawItem(1), rawItem(2, { pull_request: { merged_at: null } })]));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPlanningSnapshot();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(snapshot.epicsTruncated).toBe(false);
    expect(snapshot.items.map((item) => item.parentNumber)).toEqual([null, null]);
  });

  it("resolves parent numbers from the sub_issues endpoint of every epic", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const parent = subIssuesPath(input);
      if (parent === 30) return response([rawItem(11), rawItem(12)]);
      if (parent === 20) return response([rawItem(13)]);
      if (parent !== null) return response([]);
      return response([rawEpic(30, 2), rawEpic(20, 1), rawItem(11), rawItem(12), rawItem(13)]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPlanningSnapshot();

    expect(Object.fromEntries(snapshot.items.map((item) => [item.number, item.parentNumber]))).toEqual({
      30: null,
      20: null,
      11: 30,
      12: 30,
      13: 20,
    });
    // One list page plus exactly one request per epic.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0]))
      .toBe(`https://api.github.com/repos/leoncheng57/dcaleon/issues/30/sub_issues?per_page=${PLANNING_LIMITS.epicChildren}`);
    expect(snapshot.epicsTruncated).toBe(false);
  });

  it("never treats a pull request as an epic even when it reports sub-issues", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (subIssuesPath(input) !== null) throw new Error("pull requests must not be probed");
      return response([
        rawItem(50, { pull_request: { merged_at: null }, sub_issues_summary: { total: 4, completed: 1 } }),
        rawItem(11),
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPlanningSnapshot();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(snapshot.items[0]).toMatchObject({ type: "pull_request", childCount: 4 });
    expect(snapshot.items[1].parentNumber).toBeNull();
  });

  it("fails open per epic: one rejected or malformed response leaves the others resolved", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const parent = subIssuesPath(input);
      if (parent === 40) return response({ message: "upstream-secret-detail" }, 500);
      if (parent === 30) return response({ not: "an array" });
      if (parent === 20) return response([rawItem(13)]);
      return response([rawEpic(40, 1), rawEpic(30, 1), rawEpic(20, 1), rawItem(11), rawItem(12), rawItem(13)]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPlanningSnapshot();

    expect(Object.fromEntries(snapshot.items.map((item) => [item.number, item.parentNumber]))).toEqual({
      40: null,
      30: null,
      20: null,
      11: null,
      12: null,
      13: 20,
    });
    expect(snapshot.epicsTruncated).toBe(false);
  });

  it("reports truncation and stops probing once the epic cap is reached", async () => {
    const epics = Array.from({ length: PLANNING_LIMITS.epics + 3 }, (_, index) => rawEpic(index + 1, 1));
    const probed: number[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const parent = subIssuesPath(input);
      if (parent !== null) {
        probed.push(parent);
        return response([]);
      }
      return response(epics);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPlanningSnapshot();

    expect(snapshot.epicsTruncated).toBe(true);
    expect(probed).toHaveLength(PLANNING_LIMITS.epics);
    // Highest numbers first, so the cap is deterministic rather than page-order luck.
    expect([...probed].sort((left, right) => right - left)).toEqual(probed);
    expect(probed[0]).toBe(PLANNING_LIMITS.epics + 3);
  });

  it("reads at most epicChildren entries and ignores numbers outside the snapshot", async () => {
    const children = Array.from({ length: PLANNING_LIMITS.epicChildren + 5 }, (_, index) => rawItem(index + 1));
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (subIssuesPath(input) !== null) {
        // A self-reference and an out-of-window child must both be ignored.
        return response([rawItem(9000), { number: "not-a-number" }, null, rawEpic(500, 1), ...children]);
      }
      return response([rawEpic(500, PLANNING_LIMITS.epicChildren + 5), ...children]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPlanningSnapshot();

    expect(snapshot.items.some((item) => item.number === 9000)).toBe(false);
    expect(snapshot.items.find((item) => item.number === 500)?.parentNumber).toBeNull();
    const resolved = snapshot.items.filter((item) => item.parentNumber === 500);
    // Four non-child entries consume slots in the capped window before the children do.
    expect(resolved).toHaveLength(PLANNING_LIMITS.epicChildren - 4);
    expect(snapshot.items.find((item) => item.number === PLANNING_LIMITS.epicChildren + 5)?.parentNumber).toBeNull();
  });

  it("gives a child claimed by two epics the higher-numbered parent, deterministically", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (subIssuesPath(input) !== null) return response([rawItem(11)]);
      return response([rawEpic(20, 1), rawEpic(30, 1), rawItem(11)]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getPlanningSnapshot();

    expect(snapshot.items.find((item) => item.number === 11)?.parentNumber).toBe(30);
  });

  it("keeps the fan-out inside the existing snapshot cache", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => (subIssuesPath(input) !== null
      ? response([rawItem(11)])
      : response([rawEpic(30, 1), rawItem(11)])));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getPlanningSnapshot();
    const second = await getPlanningSnapshot();

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("GitHub planning issue creation", () => {
  it("strictly validates and normalizes create input", () => {
    expect(validateCreatePlanningIssue({ title: "  Ship it  ", body: "## Why", labels: ["frontend", "frontend", "mobile"] }))
      .toEqual({ title: "Ship it", body: "## Why", labels: ["frontend", "mobile"] });
    for (const invalid of [
      null,
      [],
      {},
      { title: "   " },
      { title: "line\nbreak" },
      { title: "ok", owner: "attacker" },
      { title: "ok", body: 1 },
      { title: "ok", labels: "frontend" },
      { title: "ok", labels: [1] },
      { title: "ok", labels: Array.from({ length: PLANNING_LIMITS.createLabels + 1 }, (_, index) => `label-${index}`) },
      { title: "x".repeat(PLANNING_LIMITS.createTitleCharacters + 1) },
      { title: "ok", body: "x".repeat(PLANNING_LIMITS.createBodyCharacters + 1) },
    ]) expect(() => validateCreatePlanningIssue(invalid)).toThrow();
  });

  it("requires the server token without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createPlanningIssue({ title: "Test", body: "", labels: [] })).rejects.toThrow("Authentication unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts only bounded fields to the fixed repository and normalizes the result URL", async () => {
    vi.stubEnv("GITHUB_TOKEN", "server-secret");
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/repos/leoncheng57/dcaleon/issues");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer server-secret");
      expect(headers.get("user-agent")).toBe("custom-dca-opencode");
      expect(JSON.parse(String(init?.body))).toEqual({ title: "New issue", body: "Details", labels: ["frontend"] });
      return response(rawItem(123, { title: "New issue", html_url: "https://attacker.invalid/issue" }), 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    const issue = await createPlanningIssue({ title: "New issue", body: "Details", labels: ["frontend"] });

    expect(issue).toMatchObject({ number: 123, type: "issue", url: "https://github.com/leoncheng57/dcaleon/issues/123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, {}, "Authentication unavailable"],
    [403, { "Retry-After": "60" }, "Rate limited"],
    [422, {}, "Rejected by GitHub"],
    [500, {}, "Unavailable"],
  ] as const)("sanitizes create HTTP %s without retrying", async (status, headers, expected) => {
    vi.stubEnv("GITHUB_TOKEN", "must-never-leak");
    const fetchMock = vi.fn(async () => response({ secret: "upstream-body" }, status, headers));
    vi.stubGlobal("fetch", fetchMock);
    const error = await createPlanningIssue({ title: "Test", body: "", labels: [] }).catch((reason: unknown) => reason);
    expect(planningErrorMessage(error)).toBe(expected);
    expect(String(error)).not.toContain("must-never-leak");
    expect(String(error)).not.toContain("upstream-body");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("loads and caches label names and descriptions without colors", async () => {
    const fetchMock = vi.fn(async () => response([{ name: "frontend", description: "Client work", color: "ff0000" }]));
    vi.stubGlobal("fetch", fetchMock);
    const first = await getPlanningLabels();
    const second = await getPlanningLabels();
    expect(first).toEqual({ labels: [{ name: "frontend", description: "Client work" }], truncated: false });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates a warm snapshot only after successful creation", async () => {
    vi.stubEnv("GITHUB_TOKEN", "server-secret");
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") return response(rawItem(200), 201);
      reads += 1;
      return response([rawItem(reads)]);
    }));
    await getPlanningSnapshot();
    await getPlanningSnapshot();
    expect(reads).toBe(1);
    await createPlanningIssue({ title: "New", body: "", labels: [] });
    await getPlanningSnapshot();
    expect(reads).toBe(2);
  });
});

describe("GitHub planning item details", () => {
  it("validates issue numbers and label replacements strictly", () => {
    expect(validatePlanningNumber("123")).toBe(123);
    expect(validatePlanningLabels([" frontend ", "FRONTEND", "priority:high"])).toEqual(["frontend", "priority:high"]);
    expect(validateUpdatePlanningLabels({ labels: ["frontend"] })).toEqual({ labels: ["frontend"] });
    for (const invalid of ["0", "1.5", "1e2", "-1", "", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validatePlanningNumber(invalid)).toThrow("Issue number is invalid");
    }
    expect(() => validatePlanningLabels(["priority:high", "priority:low"])).toThrow("Select at most one priority label");
    expect(() => validatePlanningLabels(Array.from({ length: PLANNING_LIMITS.labels + 1 }, (_, index) => `label-${index}`)))
      .toThrow(`At most ${PLANNING_LIMITS.labels} labels may be selected`);
    expect(() => validateUpdatePlanningLabels({ labels: [], title: "no" })).toThrow("Label update must contain only labels");
  });

  it("loads a bounded body and first 50 conversation comments for issues and pull requests", async () => {
    const longBody = "x".repeat(PLANNING_LIMITS.detailBodyCharacters + 1);
    const longComment = "y".repeat(PLANNING_LIMITS.commentBodyCharacters + 1);
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/comments")) {
        expect(url).toContain("per_page=51");
        return response(Array.from({ length: 51 }, (_, index) => ({
          id: index + 1,
          body: index === 0 ? longComment : `Comment ${index + 1}`,
          user: { login: `author-${index + 1}` },
          created_at: "2026-08-21T11:30:00Z",
        })));
      }
      return response(rawItem(101, {
        body: longBody,
        labels: Array.from({ length: PLANNING_LIMITS.labels + 1 }, (_, index) => ({ name: `label-${index}` })),
        pull_request: { merged_at: null },
        html_url: "https://attacker.invalid/item",
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const details = await getPlanningItemDetails("101");

    expect(details.item).toMatchObject({ number: 101, type: "pull_request", url: "https://github.com/leoncheng57/dcaleon/pull/101" });
    expect(details.item.labels).toHaveLength(PLANNING_LIMITS.labels);
    expect(details.itemLabelsTruncated).toBe(true);
    expect(details.body).toHaveLength(PLANNING_LIMITS.detailBodyCharacters);
    expect(details.bodyTruncated).toBe(true);
    expect(details.comments).toHaveLength(PLANNING_LIMITS.comments);
    expect(details.comments[0]).toMatchObject({ author: "author-1", bodyTruncated: true });
    expect(details.commentsTruncated).toBe(true);
    expect(details.commentsError).toBeNull();
  });

  it("keeps item details available when comments fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => String(input).includes("/comments")
      ? response({ secret: "do not leak" }, 500)
      : response(rawItem(7, { body: "Visible description" }))));

    const details = await getPlanningItemDetails(7);

    expect(details.body).toBe("Visible description");
    expect(details.comments).toEqual([]);
    expect(details.commentsError).toBe("Unavailable");
  });
});

describe("GitHub planning label updates", () => {
  it("requires authentication and rejects priority conflicts before requesting GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(updatePlanningItemLabels(1, { labels: ["frontend"] })).rejects.toThrow("Authentication unavailable");
    await expect(updatePlanningItemLabels(1, { labels: ["priority:high", "priority:low"] })).rejects.toThrow("Select at most one priority label");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces only labels on the fixed repository and normalizes the updated item", async () => {
    vi.stubEnv("GITHUB_TOKEN", "server-secret");
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).includes("/labels?")) {
        return response([
          { name: "priority:medium", description: "Plan next" },
          { name: "frontend", description: "Client work" },
        ]);
      }
      if (init?.method !== "PATCH") return response(rawItem(102, { labels: [{ name: "priority:high" }] }));
      expect(String(input)).toBe("https://api.github.com/repos/leoncheng57/dcaleon/issues/102");
      expect(init?.method).toBe("PATCH");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-secret");
      expect(JSON.parse(String(init?.body))).toEqual({ labels: ["priority:medium", "frontend"] });
      return response(rawItem(102, {
        labels: [{ name: "priority:medium" }, { name: "frontend" }],
        pull_request: { merged_at: null },
        html_url: "https://attacker.invalid/item",
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const item = await updatePlanningItemLabels(102, { labels: ["priority:medium", "frontend"] });

    expect(item).toMatchObject({
      number: 102,
      type: "pull_request",
      labels: ["priority:medium", "frontend"],
      url: "https://github.com/leoncheng57/dcaleon/pull/102",
    });
  });

  it("rejects labels outside the complete repository catalogue", async () => {
    vi.stubEnv("GITHUB_TOKEN", "server-secret");
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      expect(String(input)).toContain("/labels?");
      return response([{ name: "frontend", description: "Client work" }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(updatePlanningItemLabels(1, { labels: ["not-a-repository-label"] }))
      .rejects.toThrow("Unknown label: not-a-repository-label");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses replacement when the current item has labels the editor cannot represent", async () => {
    vi.stubEnv("GITHUB_TOKEN", "server-secret");
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes("/labels?")) return response([{ name: "frontend", description: "Client work" }]);
      return response(rawItem(1, {
        labels: Array.from({ length: PLANNING_LIMITS.labels + 1 }, (_, index) => ({ name: `label-${index}` })),
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(updatePlanningItemLabels(1, { labels: ["frontend"] }))
      .rejects.toThrow("Item has too many labels to update safely");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates a warm snapshot only after a successful label update", async () => {
    vi.stubEnv("GITHUB_TOKEN", "server-secret");
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).includes("/labels?")) return response([{ name: "frontend", description: "Client work" }]);
      if (init?.method === "PATCH") return response(rawItem(1, { labels: [{ name: "frontend" }] }));
      if (String(input).endsWith("/issues/1")) return response(rawItem(1, { labels: [] }));
      reads += 1;
      return response([rawItem(reads)]);
    }));
    await getPlanningSnapshot();
    await getPlanningSnapshot();
    expect(reads).toBe(1);
    await updatePlanningItemLabels(1, { labels: ["frontend"] });
    await getPlanningSnapshot();
    expect(reads).toBe(2);
  });
});
