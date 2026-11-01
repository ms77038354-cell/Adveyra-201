import express from "express";
import cookieSession from "cookie-session";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";

const app = express();
const PORT = process.env.PORT || 10000;
const ROOT = path.resolve("workspace");
const MAX_FILE_BYTES = 500_000;

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(cookieSession({
  name: "adveyra_session",
  keys: [process.env.SESSION_SECRET || "CHANGE_THIS_SESSION_SECRET_BEFORE_DEPLOY"],
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 8 * 60 * 60 * 1000
}));
app.use(express.static("public"));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

function requireAuth(req, res, next) {
  if (!req.session?.admin) return res.status(401).json({ error: "Please log in." });
  next();
}

function safePath(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("A file path is required.");
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.split("/").some(part => part === ".." || part === ".")) throw new Error("Invalid path.");
  const full = path.resolve(ROOT, normalized);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error("Path is outside the project workspace.");
  return { full, relative: normalized };
}

async function ensureWorkspace() {
  await fs.mkdir(ROOT, { recursive: true });
}
await ensureWorkspace();

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "ADVEYRA AI STUDIO" }));

app.get("/api/session", (req, res) => res.json({ authenticated: Boolean(req.session?.admin), username: req.session?.username || null }));

app.post("/api/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const expectedUser = process.env.ADMIN_USERNAME;
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!expectedUser || !hash) return res.status(503).json({ error: "Admin credentials are not configured on the server." });
  if (username !== expectedUser || typeof password !== "string" || !(await bcrypt.compare(password, hash))) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }
  req.session = { admin: true, username: expectedUser };
  res.json({ ok: true });
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/files", requireAuth, async (_req, res) => {
  async function walk(dir, prefix = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) result.push({ path: rel, type: "directory" }, ...(await walk(path.join(dir, entry.name), rel)));
      else result.push({ path: rel, type: "file" });
    }
    return result;
  }
  res.json({ files: await walk(ROOT) });
});

app.get("/api/file", requireAuth, async (req, res) => {
  try {
    const { full, relative } = safePath(req.query.path);
    const content = await fs.readFile(full, "utf8");
    res.json({ path: relative, content });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/file", requireAuth, async (req, res) => {
  try {
    const { full, relative } = safePath(req.body?.path);
    const content = req.body?.content;
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      return res.status(400).json({ error: "File content must be text and no larger than 500 KB." });
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
    res.json({ ok: true, path: relative });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/chat", requireAuth, apiLimiter, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY is not configured in the hosting environment." });
  const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-16) : [];
  if (!messages.length) return res.status(400).json({ error: "No chat messages provided." });

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const tools = [
    {
      type: "function", name: "list_project_files",
      description: "List all files in the current project workspace.",
      strict: true, parameters: { type: "object", properties: {}, required: [], additionalProperties: false }
    },
    {
      type: "function", name: "read_project_file",
      description: "Read a UTF-8 text file from the current project workspace.",
      strict: true, parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }
    },
    {
      type: "function", name: "write_project_file",
      description: "Create or replace a UTF-8 text file in the project workspace. Only write files needed for the user's requested project changes.",
      strict: true, parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false }
    }
  ];

  async function runTool(name, args) {
    if (name === "list_project_files") {
      async function walk(dir, prefix = "") {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        let out = [];
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) out.push(...await walk(path.join(dir, entry.name), rel));
          else out.push(rel);
        }
        return out;
      }
      return JSON.stringify(await walk(ROOT));
    }
    if (name === "read_project_file") {
      const { full } = safePath(args.path);
      return await fs.readFile(full, "utf8");
    }
    if (name === "write_project_file") {
      const { full, relative } = safePath(args.path);
      if (typeof args.content !== "string" || Buffer.byteLength(args.content, "utf8") > MAX_FILE_BYTES) throw new Error("File is too large or invalid.");
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, args.content, "utf8");
      return `Saved ${relative}`;
    }
    throw new Error("Unknown tool.");
  }

  try {
    let input = messages.map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 12000)
    }));
    let response;
    for (let turn = 0; turn < 6; turn++) {
      response = await client.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-5.5",
        instructions: `You are ADVEYRA AI STUDIO, a careful senior software engineer and coding agent.
You can inspect, create and edit real project files using the available tools.
Before modifying an existing project, inspect its files first. Preserve existing functionality and avoid unnecessary rewrites.
Use relative paths only. Never request, reveal, or write secrets, API keys, passwords, or .env files.
Do not claim that a command, test, preview, GitHub push, or deployment was performed unless this application actually provides and confirms that operation.
You do not have a shell or deployment tool. You can create and edit project files only.
When asked to build something, create practical working source files, then summarize files changed and any manual setup still required.
Ask before destructive changes.`, 
        input, tools
      });
      const calls = (response.output || []).filter(x => x.type === "function_call");
      if (!calls.length) break;
      input.push(...response.output);
      for (const call of calls) {
        let result;
        try { result = await runTool(call.name, JSON.parse(call.arguments || "{}")); }
        catch (e) { result = `Tool error: ${e.message}`; }
        input.push({ type: "function_call_output", call_id: call.call_id, output: String(result).slice(0, 20000) });
      }
    }
    res.json({ reply: response?.output_text || "The agent completed its tool steps. Please check the project files." });
  } catch (e) {
    console.error("OpenAI request failed:", e?.message || e);
    res.status(500).json({ error: e?.message || "AI request failed." });
  }
});

app.post("/api/github/push", requireAuth, apiLimiter, async (req, res) => {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;
  const branch = process.env.GITHUB_BRANCH || "main";
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return res.status(503).json({ error: "Configure GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO in hosting environment variables first." });
  }
  try {
    async function gh(url, options = {}) {
      const r = await fetch(`https://api.github.com${url}`, {
        ...options,
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || `GitHub API error ${r.status}`);
      return data;
    }
    let ref;
    try { ref = await gh(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/${branch}`); }
    catch { return res.status(400).json({ error: `Branch '${branch}' was not found. Create the repository and branch first.` }); }
    const parentSha = ref.object.sha;
    const parentCommit = await gh(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${parentSha}`);
    async function walk(dir, prefix = "") {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      let out = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...await walk(path.join(dir, entry.name), rel));
        else {
          const content = await fs.readFile(path.join(dir, entry.name));
          const blob = await gh(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs`, { method: "POST", body: JSON.stringify({ content: content.toString("base64"), encoding: "base64" }) });
          out.push({ path: rel, mode: "100644", type: "blob", sha: blob.sha });
        }
      }
      return out;
    }
    const treeItems = await walk(ROOT);
    const tree = await gh(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees`, {
      method: "POST", body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: treeItems })
    });
    const commit = await gh(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits`, {
      method: "POST", body: JSON.stringify({ message: req.body?.message || "Update from ADVEYRA AI Studio", tree: tree.sha, parents: [parentSha] })
    });
    await gh(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${branch}`, {
      method: "PATCH", body: JSON.stringify({ sha: commit.sha })
    });
    res.json({ ok: true, commit: commit.sha, url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/commit/${commit.sha}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`ADVEYRA AI STUDIO listening on ${PORT}`));
