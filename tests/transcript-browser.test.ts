import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptBrowserContext, TranscriptLink, transcriptBrowserUrl } from "../client/lib/transcriptBrowser.js";

describe("transcript browser links", () => {
  it("accepts web URLs only, leaving server-side network policy authoritative", () => {
    expect(transcriptBrowserUrl("https://leoncheng.dev/docs")).toBe("https://leoncheng.dev/docs");
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "mailto:a@example.com", "/docs", "#part", "https://["]) {
      expect(transcriptBrowserUrl(url)).toBeNull();
    }
    expect(transcriptBrowserUrl("http://127.0.0.1/")).toBe("http://127.0.0.1/"); // BFF must refuse, not silently open externally.
  });
  it("adds the icon and accessible action only inside the transcript provider", () => {
    const link = createElement(TranscriptLink, { href: "https://leoncheng.dev" }, "Website");
    expect(renderToStaticMarkup(link)).not.toContain("data-session-browser-link");
    const rendered = renderToStaticMarkup(createElement(TranscriptBrowserContext.Provider, { value: () => undefined }, link));
    expect(rendered).toContain('data-session-browser-link="true"');
    expect(rendered).toContain("<svg");
    expect(rendered).toContain("open in session browser");
  });
});
