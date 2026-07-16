import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html", host: "localhost" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Castle game shell and social metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Castle (?:—|-) Play chess together<\/title>/);
  assert.match(html, /Classic chess/);
  assert.match(html, /LIVE MULTIPLAYER/);
  assert.match(html, /og\.png/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("keeps multiplayer rules and persistence on the server", async () => {
  const [worker, client, hosting] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/GameClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /new WebSocketPair/);
  assert.match(worker, /chess\.move/);
  assert.match(worker, /settleGame/);
  assert.match(worker, /message\.type === "resign"/);
  assert.match(client, /new WebSocket/);
  assert.match(hosting, /"d1": "DB"/);
});
