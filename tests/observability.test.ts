import { describe, expect, it } from "vitest";
import { renderAlloyConfig } from "../scripts/observability.js";

describe("Grafana Alloy configuration", () => {
  it("ships only the BFF launchd logs with Grafana Cloud credentials", () => {
    const config = renderAlloyConfig({
      url: "https://logs-prod-123.grafana.net/loki/api/v1/push",
      username: "12345",
      token: "glc_secret",
      logDirectory: "/Users/Example/App/.state/logs",
    });

    expect(config).toContain('__path__ = "/Users/Example/App/.state/logs/bff.launchd.*.log"');
    expect(config).toContain('url = "https://logs-prod-123.grafana.net/loki/api/v1/push"');
    expect(config).toContain('username = "12345"');
    expect(config).toContain('password = "glc_secret"');
    expect(config).toContain('job = "custom-dca-opencode-bff"');
    expect(config).not.toContain("opencode.launchd");
  });
});
