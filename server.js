#!/usr/bin/env node
/**
 * MCP server for Jenkins at jenkins.scylladb.com.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const JENKINS_URL = process.env.JENKINS_URL || "https://jenkins.scylladb.com";
const JENKINS_USER = process.env.JENKINS_USER || "";
const JENKINS_TOKEN = process.env.JENKINS_TOKEN || "";

const AUTH_HEADER =
  JENKINS_USER && JENKINS_TOKEN
    ? "Basic " + Buffer.from(`${JENKINS_USER}:${JENKINS_TOKEN}`).toString("base64")
    : "";

// --- Helpers ---

async function jenkinsGet(path, params) {
  const url = new URL(path, JENKINS_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: AUTH_HEADER ? { Authorization: AUTH_HEADER } : {},
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Jenkins GET ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function jenkinsGetText(path) {
  const url = new URL(path, JENKINS_URL);
  const res = await fetch(url, {
    headers: AUTH_HEADER ? { Authorization: AUTH_HEADER } : {},
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Jenkins GET ${path} failed: ${res.status} ${res.statusText}`);
  return res.text();
}

async function jenkinsPost(path, data) {
  const headers = AUTH_HEADER ? { Authorization: AUTH_HEADER } : {};
  // Fetch CSRF crumb
  try {
    const crumb = await jenkinsGet("/crumbIssuer/api/json");
    headers[crumb.crumbRequestField] = crumb.crumb;
  } catch { /* CSRF crumb is optional — some Jenkins instances disable it */ }
  const url = new URL(path, JENKINS_URL);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: data ? new URLSearchParams(data).toString() : "",
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Jenkins POST ${path} failed: ${res.status} ${res.statusText}`);
  return res;
}

function jobPath(jobName) {
  const parts = jobName.replace(/^\/|\/$/g, "").split("/");
  return "/job/" + parts.map((p) => encodeURIComponent(p)).join("/job/");
}

function formatDuration(ms) {
  if (!ms) return "N/A";
  let s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  let m = Math.floor(s / 60);
  s = s % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  m = m % 60;
  return `${h}h ${m}m ${s}s`;
}

function buildResult(result) {
  return result === null || result === undefined ? "RUNNING" : result;
}

// --- MCP Server ---

const server = new McpServer({
  name: "jenkins",
  version: "1.0.0",
});

server.tool(
  "list_jobs",
  "List Jenkins jobs. Optionally provide a folder path (e.g. 'scylla-master') to list jobs within that folder.",
  { folder: z.string().optional().default("").describe("Folder path like 'scylla-master'. Empty for root.") },
  async ({ folder }) => {
    const base = folder ? jobPath(folder) : "";
    const data = await jenkinsGet(`${base}/api/json`, { tree: "jobs[name,url,color,_class]" });
    const jobs = data.jobs || [];
    if (!jobs.length) return { content: [{ type: "text", text: "No jobs found." }] };
    const lines = jobs.map((j) => {
      const cls = (j._class || "").split(".").pop() || "Unknown";
      return cls === "Folder" ? `[Folder] ${j.name}` : `[${cls}] ${j.name} (${j.color || ""})`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "get_job_info",
  "Get detailed information about a Jenkins job.",
  { job_name: z.string().describe("Full job path like 'scylla-master/scylla-ci'.") },
  async ({ job_name }) => {
    const path = jobPath(job_name);
    const data = await jenkinsGet(`${path}/api/json`, {
      tree: "name,url,description,color,buildable,healthReport[description,score]," +
        "lastBuild[number,url,result,timestamp,duration]," +
        "lastSuccessfulBuild[number,url]," +
        "lastFailedBuild[number,url]," +
        "property[parameterDefinitions[name,type,defaultParameterValue[value],description,choices]]," +
        "inQueue,nextBuildNumber",
    });
    const lines = [`# ${data.name}`, `URL: ${data.url || "N/A"}`];
    if (data.description) lines.push(`Description: ${data.description}`);
    lines.push(`Buildable: ${data.buildable ?? "N/A"}`);
    lines.push(`Color: ${data.color || "N/A"}`);
    if (data.inQueue) lines.push("Status: IN QUEUE");
    for (const hr of data.healthReport || []) {
      lines.push(`Health: ${hr.description || ""} (score: ${hr.score ?? "N/A"})`);
    }
    const lb = data.lastBuild;
    if (lb) {
      lines.push(`Last build: #${lb.number} - ${buildResult(lb.result)} (${formatDuration(lb.duration)})`);
    }
    if (data.lastSuccessfulBuild) lines.push(`Last successful: #${data.lastSuccessfulBuild.number}`);
    if (data.lastFailedBuild) lines.push(`Last failed: #${data.lastFailedBuild.number}`);
    for (const prop of data.property || []) {
      const params = prop.parameterDefinitions || [];
      if (params.length) {
        lines.push("\n## Parameters:");
        for (const p of params) {
          const def = p.defaultParameterValue?.value || "";
          const desc = p.description || "";
          const choices = p.choices || [];
          let line = `  - ${p.name} (${p.type || "?"})`;
          if (def) line += ` [default: ${def}]`;
          if (desc) line += ` — ${desc}`;
          if (choices.length) line += ` choices: ${JSON.stringify(choices)}`;
          lines.push(line);
        }
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "get_build_info",
  "Get information about a specific build.",
  {
    job_name: z.string().describe("Full job path."),
    build_number: z.string().optional().default("lastBuild").describe("Build number or 'lastBuild', 'lastSuccessfulBuild', 'lastFailedBuild'."),
  },
  async ({ job_name, build_number }) => {
    const path = jobPath(job_name);
    const data = await jenkinsGet(`${path}/${build_number}/api/json`, {
      tree: "number,url,result,timestamp,duration,estimatedDuration,building," +
        "displayName,description,executor,keepLog," +
        "actions[parameters[name,value],causes[shortDescription]]," +
        "changeSets[items[msg,author[fullName]]]",
    });
    const lines = [
      `# Build #${data.number}`,
      `URL: ${data.url || "N/A"}`,
      `Result: ${buildResult(data.result)}`,
      `Building: ${data.building || false}`,
      `Duration: ${formatDuration(data.duration)}`,
      `Estimated: ${formatDuration(data.estimatedDuration)}`,
    ];
    if (data.description) lines.push(`Description: ${data.description}`);
    for (const action of data.actions || []) {
      for (const cause of action.causes || []) {
        lines.push(`Cause: ${cause.shortDescription || "N/A"}`);
      }
      const params = action.parameters || [];
      if (params.length) {
        lines.push("\n## Parameters:");
        for (const p of params) lines.push(`  - ${p.name} = ${p.value ?? ""}`);
      }
    }
    for (const cs of data.changeSets || []) {
      const items = cs.items || [];
      if (items.length) {
        lines.push("\n## Changes:");
        for (const item of items.slice(0, 20)) {
          const author = item.author?.fullName || "?";
          const msg = (item.msg || "").split("\n")[0];
          lines.push(`  - [${author}] ${msg}`);
        }
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "get_console_output",
  "Get console output from a Jenkins build.",
  {
    job_name: z.string().describe("Full job path."),
    build_number: z.string().optional().default("lastBuild").describe("Build number or 'lastBuild'."),
    tail_lines: z.number().optional().default(200).describe("Lines from end. 0 for full output."),
  },
  async ({ job_name, build_number, tail_lines }) => {
    const path = jobPath(job_name);
    let text = await jenkinsGetText(`${path}/${build_number}/consoleText`);
    if (tail_lines > 0) {
      const allLines = text.split("\n");
      if (allLines.length > tail_lines) {
        text = `... (${allLines.length - tail_lines} lines truncated) ...\n` + allLines.slice(-tail_lines).join("\n");
      }
    }
    if (text.length > 100_000) {
      text = text.slice(0, 50_000) + "\n\n... (output truncated) ...\n\n" + text.slice(-50_000);
    }
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "trigger_build",
  "Trigger a Jenkins build.",
  {
    job_name: z.string().describe("Full job path."),
    parameters: z.record(z.string()).optional().describe("Optional build parameters."),
  },
  async ({ job_name, parameters }) => {
    const path = jobPath(job_name);
    if (parameters && Object.keys(parameters).length) {
      await jenkinsPost(`${path}/buildWithParameters`, parameters);
    } else {
      await jenkinsPost(`${path}/build`);
    }
    return { content: [{ type: "text", text: `Build triggered for ${job_name}.` }] };
  }
);

server.tool(
  "stop_build",
  "Stop/abort a running Jenkins build.",
  {
    job_name: z.string().describe("Full job path."),
    build_number: z.string().optional().default("lastBuild").describe("Build number to stop."),
  },
  async ({ job_name, build_number }) => {
    const path = jobPath(job_name);
    await jenkinsPost(`${path}/${build_number}/stop`);
    return { content: [{ type: "text", text: `Stop requested for ${job_name} #${build_number}.` }] };
  }
);

server.tool(
  "get_queue",
  "Get the Jenkins build queue — items waiting to be executed.",
  {},
  async () => {
    const data = await jenkinsGet("/queue/api/json", {
      tree: "items[id,url,why,task[name,url],inQueueSince,buildable,stuck]",
    });
    const items = data.items || [];
    if (!items.length) return { content: [{ type: "text", text: "Build queue is empty." }] };
    const lines = ["# Build Queue"];
    for (const item of items) {
      const name = item.task?.name || "?";
      const why = item.why || "";
      lines.push(`- ${name}: ${why}${item.stuck ? " [STUCK]" : ""}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "list_views",
  "List all Jenkins views.",
  {},
  async () => {
    const data = await jenkinsGet("/api/json", { tree: "views[name,url]" });
    const lines = (data.views || []).map((v) => `- ${v.name}: ${v.url}`);
    return { content: [{ type: "text", text: lines.join("\n") || "No views found." }] };
  }
);

server.tool(
  "get_view_jobs",
  "List jobs in a specific Jenkins view.",
  { view_name: z.string().describe("Name of the view.") },
  async ({ view_name }) => {
    const data = await jenkinsGet(`/view/${encodeURIComponent(view_name)}/api/json`, {
      tree: "name,jobs[name,url,color,_class]",
    });
    const jobs = data.jobs || [];
    if (!jobs.length) return { content: [{ type: "text", text: `No jobs in view '${view_name}'.` }] };
    const lines = [`# View: ${data.name || view_name}`];
    for (const j of jobs) {
      const cls = (j._class || "").split(".").pop();
      lines.push(cls === "Folder" ? `  [Folder] ${j.name}` : `  [${cls}] ${j.name} (${j.color || ""})`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "search_jobs",
  "Search for Jenkins jobs by name (case-insensitive substring match).",
  {
    query: z.string().describe("Search string to match against job names."),
    folder: z.string().optional().default("").describe("Folder to search within. Empty for root."),
    max_depth: z.number().optional().default(3).describe("Recursion depth (default 3)."),
  },
  async ({ query, folder, max_depth }) => {
    const results = [];
    await searchRecursive(query.toLowerCase(), folder, results, 0, max_depth, 50);
    if (!results.length) return { content: [{ type: "text", text: `No jobs matching '${query}' found.` }] };
    return { content: [{ type: "text", text: results.join("\n") }] };
  }
);

async function searchRecursive(query, folder, results, depth, maxDepth, maxResults) {
  if (depth > maxDepth || results.length >= maxResults) return;
  const base = folder ? jobPath(folder) : "";
  let data;
  try {
    data = await jenkinsGet(`${base}/api/json`, { tree: "jobs[name,url,color,_class]" });
  } catch {
    return;
  }
  const folders = [];
  for (const j of data.jobs || []) {
    if (results.length >= maxResults) return;
    const fullPath = folder ? `${folder}/${j.name}` : j.name;
    const cls = (j._class || "").split(".").pop();
    if (j.name.toLowerCase().includes(query)) {
      results.push(cls === "Folder" ? `[Folder] ${fullPath}` : `[${cls}] ${fullPath} (${j.color || ""})`);
    }
    if (cls === "Folder" || cls === "OrganizationFolder") folders.push(fullPath);
  }
  for (const f of folders) {
    if (results.length >= maxResults) return;
    await searchRecursive(query, f, results, depth + 1, maxDepth, maxResults);
  }
}

server.tool(
  "get_build_log_section",
  "Search build console output for a pattern and return matching sections with context.",
  {
    job_name: z.string().describe("Full job path."),
    build_number: z.string().optional().default("lastBuild").describe("Build number or 'lastBuild'."),
    pattern: z.string().describe("Regex pattern to search for."),
    context_lines: z.number().optional().default(10).describe("Lines of context around each match."),
  },
  async ({ job_name, build_number, pattern, context_lines }) => {
    if (!pattern) return { content: [{ type: "text", text: "Please provide a search pattern." }] };
    const path = jobPath(job_name);
    const text = await jenkinsGetText(`${path}/${build_number}/consoleText`);
    const lines = text.split("\n");
    let regex;
    try {
      regex = new RegExp(pattern, "i");
    } catch (e) {
      return { content: [{ type: "text", text: `Invalid regex pattern: ${e.message}` }] };
    }
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        const start = Math.max(0, i - context_lines);
        const end = Math.min(lines.length, i + context_lines + 1);
        matches.push(`--- Match at line ${i + 1} ---\n` + lines.slice(start, end).join("\n"));
      }
    }
    if (!matches.length) {
      return { content: [{ type: "text", text: `No matches for '${pattern}' in build output (${lines.length} lines total).` }] };
    }
    let result = `Found ${matches.length} match(es) in ${lines.length} lines:\n\n`;
    result += matches.slice(0, 20).join("\n\n");
    if (matches.length > 20) result += `\n\n... and ${matches.length - 20} more matches`;
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "list_builds",
  "List recent builds for a job.",
  {
    job_name: z.string().describe("Full job path."),
    limit: z.number().optional().default(20).describe("Number of recent builds to list."),
  },
  async ({ job_name, limit }) => {
    const path = jobPath(job_name);
    const data = await jenkinsGet(`${path}/api/json`, {
      tree: `builds[number,url,result,timestamp,duration,building]{0,${limit}}`,
    });
    const builds = data.builds || [];
    if (!builds.length) return { content: [{ type: "text", text: `No builds found for ${job_name}.` }] };
    const lines = [`# Recent builds for ${job_name}`];
    for (const b of builds) {
      const dt = b.timestamp ? new Date(b.timestamp).toISOString().replace("T", " ").slice(0, 16) : "?";
      let result = buildResult(b.result);
      if (b.building) result = "RUNNING";
      lines.push(`  #${b.number}  ${result.padEnd(10)} ${formatDuration(b.duration).padEnd(12)} ${dt}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "get_nodes",
  "List Jenkins build nodes/agents and their status.",
  {},
  async () => {
    const data = await jenkinsGet("/computer/api/json", {
      tree: "computer[displayName,description,offline,offlineCauseReason,numExecutors,idle,temporarilyOffline]",
    });
    const nodes = data.computer || [];
    if (!nodes.length) return { content: [{ type: "text", text: "No nodes found." }] };
    const online = nodes.filter((n) => !n.offline).length;
    const lines = ["# Jenkins Nodes", `Total: ${nodes.length} (${online} online)\n`];
    for (const n of nodes) {
      const status = n.offline ? "OFFLINE" : "online";
      let line = `  ${n.displayName || "?"}: ${status} (${n.numExecutors || 0} executors${n.idle ? ", idle" : ""})`;
      if (n.offlineCauseReason) line += ` — ${n.offlineCauseReason}`;
      lines.push(line);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
