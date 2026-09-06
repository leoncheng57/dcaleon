import { createServer } from "node:http";

const port = Number(process.argv[2] || 4600);
let detailRequests = 0;
let mergeBody: unknown = null;
createServer((req, res) => {
  if (req.url === "/test/forge-reset" && req.method === "POST") {
    detailRequests = 0;
    mergeBody = null;
    res.writeHead(204).end();
    return;
  }
  if (req.url === "/test/forge-state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detailRequests, mergeBody }));
    return;
  }
  const planningDetail = req.url?.match(/^\/repos\/leoncheng57\/dcaleon\/issues\/(101|102|106|107)$/u);
  const planningComments = req.url?.match(/^\/repos\/leoncheng57\/dcaleon\/issues\/(101|102|106|107)\/comments\?/u);
  const planningSubIssues = req.url?.match(/^\/repos\/leoncheng57\/dcaleon\/issues\/(101)\/sub_issues\?/u);
  if (planningSubIssues && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{ number: 106 }, { number: 107 }]));
    return;
  }
  if (planningComments && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(planningComments[1] === "101" ? [
      {
        id: 1001,
        body: "First **planning comment**.\n\n<script data-unsafe-comment>bad()</script>",
        user: { login: "reviewer" },
        created_at: "2026-08-22T10:30:00Z",
      },
      {
        id: 1002,
        body: "A second comment with [documentation](https://example.com/docs).",
        user: { login: "maintainer" },
        created_at: "2026-08-23T11:00:00Z",
      },
    ] : planningComments[1] === "102" ? [{ id: 2001, body: "PR conversation comment.", user: { login: "reviewer" }, created_at: "2026-08-23T12:00:00Z" }] : []));
    return;
  }
  if (planningDetail && req.method === "GET") {
    const number = Number(planningDetail[1]);
    const isPull = number === 102;
    const title = number === 106
      ? "Polish compact planning controls"
      : number === 107
        ? "Document the mobile planning layout"
        : isPull ? "Add the project planning feed" : "Improve the mobile planning view";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: number,
      number,
      title,
      body: isPull ? "## Pull request description\n\nReady for review." : "## Planning context\n\nMake the roadmap easier to scan.\n\n<div data-unsafe-description>unsafe</div>",
      state: "open",
      labels: isPull
        ? [{ name: "priority:medium" }, { name: "server" }]
        : [{ name: "priority:high" }, { name: "frontend" }, { name: "mobile" }],
      user: { login: isPull ? "contributor" : "maintainer" },
      html_url: `https://github.com/leoncheng57/dcaleon/${isPull ? "pull" : "issues"}/${planningDetail[1]}`,
      created_at: isPull ? "2026-08-15T10:00:00Z" : "2026-08-12T09:00:00Z",
      updated_at: isPull ? "2026-08-22T08:15:00Z" : "2026-08-21T16:30:00Z",
      comments: isPull ? 1 : 4,
      ...(number === 101 ? { sub_issues_summary: { total: 2, completed: 1, percent_completed: 50 } } : {}),
      ...(isPull ? { pull_request: { merged_at: null } } : {}),
    }));
    return;
  }
  if (planningDetail && req.method === "PATCH") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const input = JSON.parse(raw) as { labels: string[] };
      const number = Number(planningDetail[1]);
      const isPull = number === 102;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: number,
        number,
        title: isPull ? "Add the project planning feed" : "Improve the mobile planning view",
        state: "open",
        labels: input.labels.map((name) => ({ name })),
        user: { login: isPull ? "contributor" : "maintainer" },
        html_url: `https://github.com/leoncheng57/dcaleon/${isPull ? "pull" : "issues"}/${planningDetail[1]}`,
        created_at: isPull ? "2026-08-15T10:00:00Z" : "2026-08-12T09:00:00Z",
        updated_at: "2026-08-25T12:00:00Z",
        comments: isPull ? 1 : 4,
        ...(number === 101 ? { sub_issues_summary: { total: 2, completed: 1, percent_completed: 50 } } : {}),
        ...(isPull ? { pull_request: { merged_at: null } } : {}),
      }));
    });
    return;
  }
  if (req.url?.startsWith("/repos/leoncheng57/dcaleon/issues?") && req.method === "GET") {
    const page = new URL(req.url, `http://${req.headers.host}`).searchParams.get("page");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(page === "1" ? [
      {
        id: 101,
        number: 101,
        title: "Improve the mobile planning view",
        state: "open",
        labels: [{ name: "priority:high", color: "ff0000" }, { name: "frontend", color: "123456" }, { name: "mobile", color: "abcdef" }],
        user: { login: "maintainer" },
        html_url: "https://github.com/leoncheng57/dcaleon/issues/101",
        created_at: "2026-08-12T09:00:00Z",
        updated_at: "2026-08-21T16:30:00Z",
        comments: 4,
        sub_issues_summary: { total: 2, completed: 1, percent_completed: 50 },
      },
      {
        id: 106,
        number: 106,
        title: "Polish compact planning controls",
        state: "open",
        labels: [{ name: "priority:high", color: "ff0000" }, { name: "frontend", color: "123456" }],
        user: { login: "contributor" },
        html_url: "https://github.com/leoncheng57/dcaleon/issues/106",
        created_at: "2026-08-20T09:00:00Z",
        updated_at: "2026-08-24T14:00:00Z",
        comments: 0,
      },
      {
        id: 107,
        number: 107,
        title: "Document the mobile planning layout",
        state: "closed",
        labels: [{ name: "priority:low", color: "cccccc" }, { name: "documentation", color: "123456" }],
        user: { login: "maintainer" },
        html_url: "https://github.com/leoncheng57/dcaleon/issues/107",
        created_at: "2026-08-20T10:00:00Z",
        updated_at: "2026-08-24T15:00:00Z",
        comments: 1,
      },
      {
        id: 102,
        number: 102,
        title: "Add the project planning feed",
        state: "open",
        labels: [{ name: "priority:medium", color: "ffaa00" }, { name: "server", color: "654321" }],
        user: { login: "contributor" },
        html_url: "https://github.com/leoncheng57/dcaleon/pull/102",
        created_at: "2026-08-15T10:00:00Z",
        updated_at: "2026-08-22T08:15:00Z",
        comments: 2,
        pull_request: { merged_at: null },
      },
      {
        id: 99,
        number: 99,
        title: "Ship session-first notifications",
        state: "closed",
        labels: [{ name: "priority:low", color: "cccccc" }, { name: "notifications", color: "fedcba" }],
        user: { login: "maintainer" },
        html_url: "https://github.com/leoncheng57/dcaleon/pull/99",
        created_at: "2026-08-01T12:00:00Z",
        updated_at: "2026-08-20T18:45:00Z",
        comments: 8,
        pull_request: { merged_at: "2026-08-20T18:45:00Z" },
      },
      {
        id: 104,
        number: 104,
        title: "Resolve contradictory priorities",
        state: "open",
        labels: [{ name: "priority:high", color: "ff0000" }, { name: "priority:low", color: "cccccc" }, { name: "planning", color: "123456" }],
        user: { login: "maintainer" },
        html_url: "https://github.com/leoncheng57/dcaleon/issues/104",
        created_at: "2026-08-18T09:00:00Z",
        updated_at: "2026-08-23T16:30:00Z",
        comments: 1,
      },
      {
        id: 105,
        number: 105,
        title: "Audit the label catalogue",
        state: "open",
        labels: [{ name: "enhancement", color: "123456" }],
        user: { login: "maintainer" },
        html_url: "https://github.com/leoncheng57/dcaleon/issues/105",
        created_at: "2026-08-19T09:00:00Z",
        updated_at: "2026-08-24T16:30:00Z",
        comments: 0,
      },
    ] : []));
    return;
  }
  if (req.url?.startsWith("/repos/leoncheng57/dcaleon/labels?") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([
      { name: "frontend", description: "Client-side work", color: "123456" },
      { name: "mobile", description: "Phone experience", color: "abcdef" },
      { name: "server", description: "BFF and integration work", color: "654321" },
      { name: "priority:high", description: "Work now", color: "ff0000" },
      { name: "priority:medium", description: "Plan next", color: "ffaa00" },
      { name: "priority:low", description: "Backlog", color: "cccccc" },
    ]));
    return;
  }
  if (req.url === "/repos/leoncheng57/dcaleon/issues" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const input = JSON.parse(raw) as { title: string; body: string; labels: string[] };
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: 103,
        number: 103,
        title: input.title,
        body: input.body,
        state: "open",
        labels: input.labels.map((name) => ({ name, color: "000000" })),
        user: { login: "issue-author" },
        html_url: "https://attacker.invalid/not-trusted",
        created_at: "2026-08-22T19:30:00Z",
        updated_at: "2026-08-22T19:30:00Z",
        comments: 0,
      }));
    });
    return;
  }
  if (req.url === "/repos/acme/demo/pulls/7") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ title: "Mock pull request", body: "## Review notes\n\nReady to ship.", number: 7, state: "open", mergeable: true, user: { login: "octocat" }, head: { sha: "abc123" } }));
    return;
  }
  if (req.url === "/repos/acme/demo/commits/abc123/check-runs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ check_runs: [{ conclusion: "success" }] }));
    return;
  }
  if (req.url === "/repos/acme/demo/commits/abc123/check-runs?per_page=50") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ check_runs: [{ name: "test", status: "completed", conclusion: "success", html_url: "https://github.com/acme/demo/actions/1" }] }));
    return;
  }
  if (req.url === "/repos/acme/demo/issues/7/comments?per_page=51&page=1") {
    detailRequests++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{ id: 1, user: { login: "reviewer" }, body: "Looks good.", created_at: "2026-08-21T10:00:00Z" }]));
    return;
  }
  if (req.url === "/repos/acme/demo/pulls/7/reviews?per_page=26&page=1") {
    detailRequests++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{ id: 2, user: { login: "maintainer" }, state: "APPROVED", body: "Approved.", submitted_at: "2026-08-21T10:01:00Z" }]));
    return;
  }
  if (req.url === "/repos/acme/demo/pulls/7/commits?per_page=51&page=1") {
    detailRequests++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([
      { sha: "abc123def4567890abc123def4567890abc12345", html_url: "https://github.com/acme/demo/commit/abc123def4567890abc123def4567890abc12345", author: { login: "octocat" }, commit: { message: "Add the mock route\n\nLonger body text that must not appear in the subject.", author: { name: "Octo Cat", date: "2026-08-21T09:58:00Z" } } },
    ]));
    return;
  }
  if (req.url === "/repos/acme/demo/commits/abc123/check-runs?per_page=100&page=1") {
    detailRequests++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ total_count: 1, check_runs: [{ id: 3, name: "test", status: "completed", conclusion: "failure", details_url: "https://github.com/acme/demo/actions/3", started_at: "2026-08-21T10:00:00Z", completed_at: "2026-08-21T10:01:15Z" }] }));
    return;
  }
  if (req.url === "/repos/acme/demo/commits/abc123/status?per_page=100&page=1") {
    detailRequests++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ total_count: 0, statuses: [] }));
    return;
  }
  if (req.url === "/repos/acme/demo/pulls/7/merge" && req.method === "PUT") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      mergeBody = raw ? JSON.parse(raw) : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ merged: true }));
    });
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: "/target" }).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json", "X-Unsafe": "must-not-forward" });
  res.end(JSON.stringify({
    path: req.url,
    authorization: req.headers.authorization ?? null,
    cookie: req.headers.cookie ?? null,
    host: req.headers.host ?? null,
  }));
}).listen(port, "127.0.0.1", () => console.log(`[mock-preview] listening on ${port}`));
