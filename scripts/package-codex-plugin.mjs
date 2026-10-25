import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const pluginFiles = [
  "plugin.json",
  "mcp.json",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "assets/icon.png",
  "assets/icon.svg",
  "assets/screenshot.png",
  "assets/screenshot.svg",
  "skills/apple-mail/SKILL.md",
];

function readRegularFile(root, relative) {
  let current = root;
  for (const part of relative.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Symlinked input: ${relative}`);
  }
  if (!lstatSync(current).isFile()) throw new Error(`Not a regular file: ${relative}`);
  return readFileSync(current);
}

const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

// Fixed ordering, modes, owners, and timestamps make identical inputs produce
// identical archives on macOS and Linux without a platform-specific tar CLI.
function tarEntry(name, contents) {
  if (Buffer.byteLength(name) > 100 || !/^[.a-zA-Z0-9_/-]+$/.test(name)) {
    throw new Error("Unsupported archive path");
  }
  const header = Buffer.alloc(512);
  const octal = (value, offset, width) =>
    header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
  header.write(name, 0, 100, "utf8");
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(contents.length, 124, 12);
  octal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return [header, contents, Buffer.alloc((512 - (contents.length % 512)) % 512)];
}

export function packageCodexPlugin({ root, output }) {
  root = resolve(root);
  output = resolve(output);
  if (realpathSync(root) !== root || realpathSync(dirname(output)) !== dirname(output)) {
    throw new Error("Repository and output directory must use real, nonsymlinked paths");
  }
  if (!output.endsWith(".tar.gz")) throw new Error("Output must end in .tar.gz");
  const pkg = JSON.parse(readRegularFile(root, "package.json"));
  const files = new Map(pluginFiles.map((name) => [name, readRegularFile(root, `codex/${name}`)]));
  const portable = JSON.parse(files.get("plugin.json"));
  const legacy = JSON.parse(files.get(".codex-plugin/plugin.json"));
  if (
    pkg.name !== "apple-mail-mcp" ||
    portable.name !== "apple-mail" ||
    legacy.name !== portable.name ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version) ||
    portable.version !== pkg.version ||
    legacy.version !== pkg.version
  ) {
    throw new Error("Plugin identity or release version mismatch");
  }
  for (const name of ["mcp.json", ".mcp.json"]) {
    const config = JSON.parse(files.get(name));
    const expected = { command: "npx", args: ["-y", `apple-mail-mcp@${pkg.version}`] };
    if (name === "mcp.json") expected.type = "stdio";
    const server = config.mcpServers?.["apple-mail"];
    if (
      Object.keys(config.mcpServers ?? {}).join() !== "apple-mail" ||
      !server ||
      Object.keys(server).length !== Object.keys(expected).length ||
      Object.entries(expected).some(
        ([key, value]) => JSON.stringify(server[key]) !== JSON.stringify(value)
      )
    ) {
      throw new Error(`Unexpected launcher configuration: ${name}`);
    }
    config.mcpServers["apple-mail"] = {
      ...(name === "mcp.json" ? { type: "stdio" } : {}),
      command: "node",
      args: ["${PLUGIN_ROOT}/server/index.js"],
    };
    files.set(name, jsonBytes(config));
  }
  files.set("server/index.js", readRegularFile(root, "build/index.js"));
  files.set("LICENSE", readRegularFile(root, "LICENSE"));
  files.set(
    "package.json",
    jsonBytes({
      name: pkg.name,
      version: pkg.version,
      type: "module",
      license: pkg.license,
      engines: { node: ">=20.0.0" },
      os: ["darwin"],
    })
  );
  const blocks = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .flatMap(([name, bytes]) => tarEntry(name, bytes));
  const archive = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { level: 9 });
  // Exclusive creation never follows or overwrites an existing file/symlink.
  writeFileSync(output, archive, { flag: "wx", mode: 0o600 });
  return { output, version: pkg.version, files: [...files.keys()].sort(), bytes: archive.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("Usage: node scripts/package-codex-plugin.mjs /absolute/path/apple-mail.tar.gz");
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(packageCodexPlugin({ root: process.cwd(), output: process.argv[2] }))
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
