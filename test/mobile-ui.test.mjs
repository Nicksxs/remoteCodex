import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("mobile shell uses full-screen navigation and keyboard-aware sizing", async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/styles.css", root), "utf8"),
    readFile(new URL("public/app.js", root), "utf8"),
  ]);

  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(html, /id="homeThreadList"/);
  assert.match(html, /class="page-panel"/);
  assert.match(html, /class="form-page hidden"/);
  assert.match(css, /--app-height:\s*100dvh/);
  assert.match(css, /\.page-panel, \.form-page\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;/);
  assert.match(css, /input, textarea, select\s*\{\s*font-size:\s*16px;/);
  assert.match(css, /\.send-button\s*\{[\s\S]*width:\s*44px;[\s\S]*height:\s*44px;/);
  assert.match(app, /window\.visualViewport/);
  assert.match(app, /syncViewportHeight/);
  assert.match(app, /eventTransport === "poll"/);
  assert.match(app, /api\/events\/poll\?after=/);
});
