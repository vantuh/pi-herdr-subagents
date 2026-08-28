import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HERDR_AGENTS_LAYOUT, getHerdrAgentsLayout } from "../config.ts";

test("uses pane layout by default", () => {
  assert.equal(DEFAULT_HERDR_AGENTS_LAYOUT, "pane");
  assert.equal(getHerdrAgentsLayout({}), "pane");
});

test("allows tab layout through HERDR_AGENTS_LAYOUT", () => {
  assert.equal(getHerdrAgentsLayout({ HERDR_AGENTS_LAYOUT: "tab" }), "tab");
  assert.equal(getHerdrAgentsLayout({ HERDR_AGENTS_LAYOUT: " TAB " }), "tab");
});

test("falls back to pane for unsupported values", () => {
  assert.equal(getHerdrAgentsLayout({ HERDR_AGENTS_LAYOUT: "other" }), "pane");
});
