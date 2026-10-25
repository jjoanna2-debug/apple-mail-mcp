import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createInterface } from "node:readline";
import { packageCodexPlugin } from "../scripts/package-codex-plugin.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "apple-mail-package-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function sourceFixture(t) {
  const dir = fixture(t);
  for (const item of ["codex", "build", "package.json", "LICENSE"]) {
    cpSync(join(root, item), join(dir, item), { recursive: true });
  }
  return dir;
}

test("produces a deterministic, self-contained archive with unchanged source launchers", async (t) => {
  const dir = fixture(t);
  const original = readFileSync(join(root, "codex/mcp.json"));
  const first = packageCodexPlugin({ root, output: join(dir, "first.tar.gz") });
  packageCodexPlugin({ root, output: join(dir, "second.tar.gz") });
  assert.deepEqual(readFileSync(first.output), readFileSync(join(dir, "second.tar.gz")));
  assert.deepEqual(readFileSync(join(root, "codex/mcp.json")), original);
  const extract = join(dir, "extracted");
  mkdirSync(extract);
  const untar = spawnSync("tar", ["-xzf", first.output, "-C", extract], { encoding: "utf8" });
  assert.equal(untar.status, 0, untar.stderr);
  const listing = spawnSync("tar", ["-tzf", first.output], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split("\n").sort(), first.files);
  for (const config of ["mcp.json", ".mcp.json"]) {
    const server = JSON.parse(readFileSync(join(extract, config))).mcpServers["apple-mail"];
    assert.equal(server.command, "node");
    assert.deepEqual(server.args, ["${PLUGIN_ROOT}/server/index.js"]);
  }
  const pkg = JSON.parse(readFileSync(join(extract, "package.json")));
  assert.equal(pkg.version, first.version);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts, undefined);
  assert.deepEqual(
    readFileSync(join(extract, "server/index.js")),
    readFileSync(join(root, "build/index.js"))
  );
  assert.equal(existsSync(join(extract, "node_modules")), false);
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "archive-test", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const child = spawn(process.execPath, [join(extract, "server/index.js")], {
    cwd: extract,
    env: {
      PATH: process.env.PATH,
      APPLE_MAIL_MCP_CONFIG_FILE: join(dir, "no-config.json"),
      APPLE_MAIL_MCP_IMAP_IDLE: "0",
    },
  });
  const responses = await new Promise((resolve, reject) => {
    const received = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Packaged MCP startup timed out"));
    }, 15000);
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      lines.close();
      if (received.some((response) => response.id === 2)) resolve(received);
      else reject(new Error("Packaged MCP exited before returning tools"));
    });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line);
        received.push(response);
        if (response.id === 1) {
          child.stdin.write(`${JSON.stringify(requests[1])}\n${JSON.stringify(requests[2])}\n`);
        }
        if (response.id === 2) child.kill();
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    child.stdin.write(`${JSON.stringify(requests[0])}\n`);
  });
  assert.equal(
    responses.find((response) => response.id === 1).result.serverInfo.version,
    first.version
  );
  assert.equal(responses.find((response) => response.id === 2).result.tools.length, 52);
});

test("excludes private configuration and files outside the allowlist", (t) => {
  const dir = sourceFixture(t);
  writeFileSync(join(dir, "codex/.env"), "SECRET=not-for-distribution");
  writeFileSync(join(dir, "codex/config.json"), '{"password":"not-for-distribution"}');
  const result = packageCodexPlugin({ root: dir, output: join(dir, "plugin.tar.gz") });
  assert.equal(
    result.files.some((file) => /\.env|config\.json/.test(file)),
    false
  );
});

test("rejects symlinked inputs and output directories", (t) => {
  const dir = sourceFixture(t);
  const icon = join(dir, "codex/assets/icon.svg");
  rmSync(icon);
  symlinkSync(join(root, "codex/assets/icon.svg"), icon);
  assert.throws(
    () => packageCodexPlugin({ root: dir, output: join(dir, "plugin.tar.gz") }),
    /Symlinked input/
  );
  const parent = fixture(t);
  symlinkSync(dir, join(parent, "linked"));
  assert.throws(
    () => packageCodexPlugin({ root, output: join(parent, "linked/plugin.tar.gz") }),
    /nonsymlinked/
  );
});

test("never overwrites existing output or follows an output symlink", (t) => {
  const dir = fixture(t);
  const output = join(dir, "plugin.tar.gz");
  writeFileSync(output, "preserve");
  assert.throws(() => packageCodexPlugin({ root, output }), /EEXIST/);
  assert.equal(readFileSync(output, "utf8"), "preserve");
  const link = join(dir, "linked.tar.gz");
  symlinkSync(output, link);
  assert.throws(() => packageCodexPlugin({ root, output: link }), /EEXIST/);
  assert.equal(readFileSync(output, "utf8"), "preserve");
});

test("rejects release drift and unexpected launcher credentials or commands", (t) => {
  const dir = sourceFixture(t);
  const file = join(dir, "codex/mcp.json");
  const config = JSON.parse(readFileSync(file));
  config.mcpServers["apple-mail"].env = { PASSWORD: "private" };
  writeFileSync(file, JSON.stringify(config));
  assert.throws(
    () => packageCodexPlugin({ root: dir, output: join(dir, "plugin.tar.gz") }),
    /Unexpected launcher/
  );
  const manifestFile = join(dir, "codex/plugin.json");
  const manifest = JSON.parse(readFileSync(manifestFile));
  manifest.version = "0.0.0";
  writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(
    () => packageCodexPlugin({ root: dir, output: join(dir, "plugin.tar.gz") }),
    /version mismatch/
  );
});
