#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { existsSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, homedir } from "node:os";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { tools, buildInstruction, inputSchema } from "./tools.js";

const AGY_BIN = process.env.AGY_BIN || "agy";
const DEFAULT_MODEL = process.env.AGY_VISION_MODEL || "gemini-3.8-flash-medium";
const TIMEOUT_MS = Number(process.env.AGY_VISION_TIMEOUT_MS || 180000);
const MAX_BYTES = Number(process.env.AGY_VISION_MAX_BYTES || 20 * 1024 * 1024);
const MAX_OUTPUT = 4 * 1024 * 1024;
const SANDBOX = process.env.AGY_VISION_SANDBOX !== "0";
const PROFILE = join(dirname(fileURLToPath(import.meta.url)), "sandbox.sb");
const USER_AGENT =
  process.env.AGY_VISION_USER_AGENT ||
  "agy-vision-mcp/2.0 (+https://github.com/ndanhkhoi/agy-vision-mcp)";

const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
  ".heic", ".heif", ".tif", ".tiff", ".svg", ".pdf",
]);

const MIME_EXT = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
  "image/webp": ".webp", "image/bmp": ".bmp", "image/heic": ".heic",
  "image/tiff": ".tif", "image/svg+xml": ".svg", "application/pdf": ".pdf",
};

const byName = new Map(tools.map((t) => [t.name, t]));

function checkSize(abs) {
  const { size } = statSync(abs);
  if (size > MAX_BYTES) {
    throw new Error(`File too large: ${abs} (${size} bytes, limit ${MAX_BYTES}).`);
  }
  if (size === 0) throw new Error(`File is empty: ${abs}`);
}

async function download(url, scratch) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60000),
    headers: { "user-agent": USER_AGENT, accept: "image/*,application/pdf;q=0.9,*/*;q=0.5" },
  });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = MIME_EXT[mime] || extname(new URL(url).pathname).toLowerCase();
  if (!IMAGE_EXT.has(ext)) {
    throw new Error(`Remote file is not a supported image: ${url} (content-type: ${mime || "unknown"})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw new Error(`Remote file too large: ${url} (${buf.length} bytes, limit ${MAX_BYTES}).`);
  }
  const dest = join(scratch, `${randomUUID()}${ext}`);
  writeFileSync(dest, buf);
  return dest;
}

async function resolveImages(paths, scratch) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("`paths` must be a non-empty array of image paths or URLs.");
  }
  const out = [];
  for (const p of paths) {
    const raw = String(p).trim();
    if (/^https?:\/\//i.test(raw)) {
      out.push(await download(raw, scratch));
      continue;
    }
    const abs = resolve(raw.replace(/^~(?=\/)/, process.env.HOME || "~"));
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`File not found: ${abs}`);
    if (!IMAGE_EXT.has(extname(abs).toLowerCase())) {
      throw new Error(`Unsupported file type: ${abs} (allowed: ${[...IMAGE_EXT].join(", ")})`);
    }
    checkSize(abs);
    out.push(abs);
  }
  return out;
}

function composePrompt(images, instruction) {
  const list = images.map((p, i) => `${images.length > 1 ? `[${i + 1}] ` : "- "}${p}`).join("\n");
  return [
    "You are a vision analyst. Use your file-reading tool to open each of these image files, in order:",
    list,
    "",
    instruction,
  ].join("\n");
}

function runAgy(prompt, images, model) {
  const dirs = [...new Set(images.map((p) => dirname(p)))];
  const agyArgs = [
    "--print", prompt,
    "--model", model,
    "--output-format", "text",
    "--disable-slash-commands",
    "--print-timeout", `${Math.ceil(TIMEOUT_MS / 1000)}s`,
  ];
  for (const d of dirs) agyArgs.push("--add-dir", d);

  // agy's print mode auto-approves every tool call and offers no flag to restrict
  // it, so containment comes from a seatbelt profile around the process instead.
  const useSandbox = SANDBOX && platform() === "darwin" && existsSync(PROFILE);
  const bin = useSandbox ? "sandbox-exec" : AGY_BIN;
  const args = useSandbox
    ? [
        "-f", PROFILE,
        "-D", `GEMINI_DIR=${join(homedir(), ".gemini")}`,
        "-D", `ANTIGRAVITY_DIR=${join(homedir(), ".antigravity")}`,
        "-D", `CACHE_DIR=${join(homedir(), "Library", "Caches")}`,
        AGY_BIN,
        ...agyArgs,
      ]
    : agyArgs;

  return new Promise((res, rej) => {
    execFile(
      bin,
      args,
      { cwd: tmpdir(), timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        const out = (stdout || "").trim();
        if (err) {
          if (err.code === "ENOENT") {
            return rej(new Error(`\`${bin}\` not found on PATH. Set AGY_BIN to agy's full path.`));
          }
          if (err.killed) return rej(new Error(`agy timed out after ${TIMEOUT_MS} ms.`));
          return rej(new Error(`agy failed: ${(stderr || "").trim() || err.message}`));
        }
        if (!out) return rej(new Error(`agy returned empty output. stderr: ${(stderr || "").trim()}`));
        res(out);
      },
    );
  });
}

const server = new Server(
  { name: "agy-vision", version: "2.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: inputSchema(t),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = byName.get(req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  const args = req.params.arguments ?? {};
  const scratch = mkdtempSync(join(tmpdir(), "agy-vision-"));
  try {
    const images = await resolveImages(args.paths, scratch);
    if (images.length < tool.minImages) {
      throw new Error(`${tool.name} needs at least ${tool.minImages} image(s).`);
    }
    if (tool.maxImages && images.length > tool.maxImages) {
      throw new Error(`${tool.name} accepts at most ${tool.maxImages} image(s).`);
    }
    const prompt = composePrompt(images, buildInstruction(tool, args));
    const text = await runAgy(prompt, images, args.model || DEFAULT_MODEL);
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

await server.connect(new StdioServerTransport());
