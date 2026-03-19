#!/usr/bin/env python3
"""MCP server for Jenkins at jenkins.scylladb.com."""

import datetime
import os
import json
import re
from typing import Any
from urllib.parse import quote as urlquote

import httpx
from mcp.server.fastmcp import FastMCP

JENKINS_URL = os.environ.get("JENKINS_URL", "https://jenkins.scylladb.com")
JENKINS_USER = os.environ.get("JENKINS_USER", "")
JENKINS_TOKEN = os.environ.get("JENKINS_TOKEN", "")

mcp = FastMCP(
    "jenkins",
    instructions="MCP server for interacting with Jenkins CI/CD at jenkins.scylladb.com. "
    "Use these tools to list jobs, get build info, read console output, trigger builds, and more.",
)


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=JENKINS_URL,
        auth=(JENKINS_USER, JENKINS_TOKEN),
        timeout=30.0,
        follow_redirects=True,
    )


def _get_json(path: str, params: dict | None = None) -> Any:
    with _client() as c:
        r = c.get(path, params=params)
        r.raise_for_status()
        return r.json()


def _post(path: str, data: dict | None = None) -> httpx.Response:
    """POST with CSRF crumb support."""
    with _client() as c:
        # Fetch crumb
        try:
            crumb_resp = c.get("/crumbIssuer/api/json")
            crumb_resp.raise_for_status()
            crumb_data = crumb_resp.json()
            headers = {crumb_data["crumbRequestField"]: crumb_data["crumb"]}
        except Exception:
            headers = {}
        r = c.post(path, data=data, headers=headers)
        r.raise_for_status()
        return r


def _job_path(job_name: str) -> str:
    """Convert a job name like 'folder/subfolder/job' to Jenkins API path '/job/folder/job/subfolder/job/job'."""
    parts = job_name.strip("/").split("/")
    return "/job/" + "/job/".join(urlquote(p, safe="") for p in parts)


def _format_duration(ms: int | None) -> str:
    if not ms:
        return "N/A"
    s = ms // 1000
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m {s}s"
    h, m = divmod(m, 60)
    return f"{h}h {m}m {s}s"


def _build_result_emoji(result: str | None) -> str:
    if result is None:
        return "RUNNING"
    return result


# --- Tools ---


@mcp.tool()
def list_jobs(folder: str = "") -> str:
    """List Jenkins jobs. Optionally provide a folder path (e.g. 'scylla-master') to list jobs within that folder.

    Args:
        folder: Folder path like 'scylla-master' or 'scylla-master/subfolder'. Empty for root.
    """
    base = _job_path(folder) if folder else ""
    data = _get_json(f"{base}/api/json", {"tree": "jobs[name,url,color,_class]"})

    jobs = data.get("jobs", [])
    if not jobs:
        return "No jobs found."

    lines = []
    for j in jobs:
        cls = j.get("_class", "")
        short_cls = cls.rsplit(".", 1)[-1] if cls else "Unknown"
        color = j.get("color", "")
        name = j["name"]
        if short_cls == "Folder":
            lines.append(f"[Folder] {name}")
        else:
            lines.append(f"[{short_cls}] {name} ({color})")
    return "\n".join(lines)


@mcp.tool()
def get_job_info(job_name: str) -> str:
    """Get detailed information about a Jenkins job.

    Args:
        job_name: Full job path like 'scylla-master/scylla-ci' or 'siren-backend-build-lab'.
    """
    path = _job_path(job_name)
    data = _get_json(
        f"{path}/api/json",
        {
            "tree": "name,url,description,color,buildable,healthReport[description,score],"
            "lastBuild[number,url,result,timestamp,duration],"
            "lastSuccessfulBuild[number,url],"
            "lastFailedBuild[number,url],"
            "property[parameterDefinitions[name,type,defaultParameterValue[value],description,choices]],"
            "inQueue,nextBuildNumber"
        },
    )

    lines = [f"# {data['name']}", f"URL: {data.get('url', 'N/A')}"]

    if data.get("description"):
        lines.append(f"Description: {data['description']}")

    lines.append(f"Buildable: {data.get('buildable', 'N/A')}")
    lines.append(f"Color: {data.get('color', 'N/A')}")

    if data.get("inQueue"):
        lines.append("Status: IN QUEUE")

    for hr in data.get("healthReport", []):
        lines.append(f"Health: {hr.get('description', '')} (score: {hr.get('score', 'N/A')})")

    lb = data.get("lastBuild")
    if lb:
        lines.append(
            f"Last build: #{lb['number']} - {_build_result_emoji(lb.get('result'))} "
            f"({_format_duration(lb.get('duration'))})"
        )

    lsb = data.get("lastSuccessfulBuild")
    if lsb:
        lines.append(f"Last successful: #{lsb['number']}")

    lfb = data.get("lastFailedBuild")
    if lfb:
        lines.append(f"Last failed: #{lfb['number']}")

    # Parameters
    for prop in data.get("property", []):
        params = prop.get("parameterDefinitions", [])
        if params:
            lines.append("\n## Parameters:")
            for p in params:
                default = p.get("defaultParameterValue", {}).get("value", "")
                desc = p.get("description", "")
                choices = p.get("choices", [])
                line = f"  - {p['name']} ({p.get('type', '?')})"
                if default:
                    line += f" [default: {default}]"
                if desc:
                    line += f" — {desc}"
                if choices:
                    line += f" choices: {choices}"
                lines.append(line)

    return "\n".join(lines)


@mcp.tool()
def get_build_info(job_name: str, build_number: int | str = "lastBuild") -> str:
    """Get information about a specific build.

    Args:
        job_name: Full job path.
        build_number: Build number or 'lastBuild', 'lastSuccessfulBuild', 'lastFailedBuild'.
    """
    path = _job_path(job_name)
    data = _get_json(
        f"{path}/{build_number}/api/json",
        {
            "tree": "number,url,result,timestamp,duration,estimatedDuration,building,"
            "displayName,description,executor,keepLog,"
            "actions[parameters[name,value],causes[shortDescription]],"
            "changeSets[items[msg,author[fullName]]]"
        },
    )

    lines = [
        f"# Build #{data['number']}",
        f"URL: {data.get('url', 'N/A')}",
        f"Result: {_build_result_emoji(data.get('result'))}",
        f"Building: {data.get('building', False)}",
        f"Duration: {_format_duration(data.get('duration'))}",
        f"Estimated: {_format_duration(data.get('estimatedDuration'))}",
    ]

    if data.get("description"):
        lines.append(f"Description: {data['description']}")

    # Causes and parameters from actions
    for action in data.get("actions", []):
        for cause in action.get("causes", []):
            lines.append(f"Cause: {cause.get('shortDescription', 'N/A')}")
        params = action.get("parameters", [])
        if params:
            lines.append("\n## Parameters:")
            for p in params:
                lines.append(f"  - {p['name']} = {p.get('value', '')}")

    # Changes
    for cs in data.get("changeSets", []):
        items = cs.get("items", [])
        if items:
            lines.append("\n## Changes:")
            for item in items[:20]:
                author = item.get("author", {}).get("fullName", "?")
                msg = item.get("msg", "").split("\n")[0]
                lines.append(f"  - [{author}] {msg}")

    return "\n".join(lines)


@mcp.tool()
def get_console_output(
    job_name: str, build_number: int | str = "lastBuild", tail_lines: int = 200
) -> str:
    """Get console output from a Jenkins build.

    Args:
        job_name: Full job path.
        build_number: Build number or 'lastBuild'.
        tail_lines: Number of lines to return from the end. Use 0 for full output (may be very large).
    """
    path = _job_path(job_name)
    with _client() as c:
        r = c.get(f"{path}/{build_number}/consoleText")
        r.raise_for_status()
        text = r.text

    if tail_lines > 0:
        all_lines = text.splitlines()
        if len(all_lines) > tail_lines:
            text = f"... ({len(all_lines) - tail_lines} lines truncated) ...\n" + "\n".join(
                all_lines[-tail_lines:]
            )

    # Cap at ~100KB to avoid overwhelming context
    if len(text) > 100_000:
        text = text[:50_000] + "\n\n... (output truncated) ...\n\n" + text[-50_000:]

    return text


@mcp.tool()
def trigger_build(job_name: str, parameters: dict[str, str] | None = None) -> str:
    """Trigger a Jenkins build.

    Args:
        job_name: Full job path.
        parameters: Optional dict of build parameters.
    """
    path = _job_path(job_name)
    if parameters:
        _post(f"{path}/buildWithParameters", data=parameters)
    else:
        _post(f"{path}/build")
    return f"Build triggered for {job_name}."


@mcp.tool()
def stop_build(job_name: str, build_number: int | str = "lastBuild") -> str:
    """Stop/abort a running Jenkins build.

    Args:
        job_name: Full job path.
        build_number: Build number to stop. Defaults to last build.
    """
    path = _job_path(job_name)
    _post(f"{path}/{build_number}/stop")
    return f"Stop requested for {job_name} #{build_number}."


@mcp.tool()
def get_queue() -> str:
    """Get the Jenkins build queue — items waiting to be executed."""
    data = _get_json("/queue/api/json", {"tree": "items[id,url,why,task[name,url],inQueueSince,buildable,stuck]"})

    items = data.get("items", [])
    if not items:
        return "Build queue is empty."

    lines = ["# Build Queue"]
    for item in items:
        task = item.get("task", {})
        name = task.get("name", "?")
        why = item.get("why", "")
        stuck = item.get("stuck", False)
        lines.append(f"- {name}: {why}" + (" [STUCK]" if stuck else ""))

    return "\n".join(lines)


@mcp.tool()
def list_views() -> str:
    """List all Jenkins views."""
    data = _get_json("/api/json", {"tree": "views[name,url]"})
    lines = []
    for v in data.get("views", []):
        lines.append(f"- {v['name']}: {v['url']}")
    return "\n".join(lines) or "No views found."


@mcp.tool()
def get_view_jobs(view_name: str) -> str:
    """List jobs in a specific Jenkins view.

    Args:
        view_name: Name of the view (e.g. 'QA', 'Performance', 'master').
    """
    data = _get_json(
        f"/view/{urlquote(view_name, safe='')}/api/json",
        {"tree": "name,jobs[name,url,color,_class]"},
    )
    jobs = data.get("jobs", [])
    if not jobs:
        return f"No jobs in view '{view_name}'."

    lines = [f"# View: {data.get('name', view_name)}"]
    for j in jobs:
        cls = j.get("_class", "").rsplit(".", 1)[-1]
        color = j.get("color", "")
        if cls == "Folder":
            lines.append(f"  [Folder] {j['name']}")
        else:
            lines.append(f"  [{cls}] {j['name']} ({color})")
    return "\n".join(lines)


@mcp.tool()
def search_jobs(query: str, folder: str = "", max_depth: int = 3) -> str:
    """Search for Jenkins jobs by name (case-insensitive substring match).

    Args:
        query: Search string to match against job names.
        folder: Optional folder to search within. Empty searches recursively from root.
        max_depth: How deep to recurse into folders (default 3). Use 1 for shallow search.
    """
    results = []
    _search_recursive(query.lower(), folder, results, depth=0, max_depth=max_depth, max_results=50)
    if not results:
        return f"No jobs matching '{query}' found."
    return "\n".join(results)


def _search_recursive(query: str, folder: str, results: list, depth: int, max_depth: int, max_results: int):
    if depth > max_depth or len(results) >= max_results:
        return
    base = _job_path(folder) if folder else ""
    try:
        data = _get_json(f"{base}/api/json", {"tree": "jobs[name,url,color,_class]"})
    except Exception:
        return

    folders_to_recurse = []
    for j in data.get("jobs", []):
        if len(results) >= max_results:
            return
        name = j["name"]
        full_path = f"{folder}/{name}" if folder else name
        cls = j.get("_class", "").rsplit(".", 1)[-1]

        if query in name.lower():
            color = j.get("color", "")
            if cls == "Folder":
                results.append(f"[Folder] {full_path}")
            else:
                results.append(f"[{cls}] {full_path} ({color})")

        # Collect folders to recurse into
        if cls in ("Folder", "OrganizationFolder"):
            folders_to_recurse.append(full_path)

    for f in folders_to_recurse:
        if len(results) >= max_results:
            return
        _search_recursive(query, f, results, depth + 1, max_depth, max_results)


@mcp.tool()
def get_build_log_section(
    job_name: str,
    build_number: int | str = "lastBuild",
    pattern: str = "",
    context_lines: int = 10,
) -> str:
    """Search build console output for a pattern and return matching sections with context.

    Args:
        job_name: Full job path.
        build_number: Build number or 'lastBuild'.
        pattern: Regex pattern to search for in the console output.
        context_lines: Number of lines of context before and after each match.
    """
    path = _job_path(job_name)
    with _client() as c:
        r = c.get(f"{path}/{build_number}/consoleText")
        r.raise_for_status()
        text = r.text

    if not pattern:
        return "Please provide a search pattern."

    lines = text.splitlines()
    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        return f"Invalid regex pattern: {e}"

    matches = []
    for i, line in enumerate(lines):
        if regex.search(line):
            start = max(0, i - context_lines)
            end = min(len(lines), i + context_lines + 1)
            section = lines[start:end]
            marker = f"--- Match at line {i + 1} ---"
            matches.append(marker + "\n" + "\n".join(section))

    if not matches:
        return f"No matches for '{pattern}' in build output ({len(lines)} lines total)."

    # Limit output
    result = f"Found {len(matches)} match(es) in {len(lines)} lines:\n\n"
    result += "\n\n".join(matches[:20])
    if len(matches) > 20:
        result += f"\n\n... and {len(matches) - 20} more matches"
    return result


@mcp.tool()
def list_builds(job_name: str, limit: int = 20) -> str:
    """List recent builds for a job.

    Args:
        job_name: Full job path.
        limit: Number of recent builds to list.
    """
    path = _job_path(job_name)
    data = _get_json(
        f"{path}/api/json",
        {
            "tree": f"builds[number,url,result,timestamp,duration,building]{{0,{limit}}}"
        },
    )

    builds = data.get("builds", [])
    if not builds:
        return f"No builds found for {job_name}."

    lines = [f"# Recent builds for {job_name}"]
    for b in builds:
        ts = b.get("timestamp", 0)
        dt = datetime.datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M") if ts else "?"
        result = _build_result_emoji(b.get("result"))
        if b.get("building"):
            result = "RUNNING"
        dur = _format_duration(b.get("duration"))
        lines.append(f"  #{b['number']}  {result:<10} {dur:<12} {dt}")

    return "\n".join(lines)


@mcp.tool()
def get_nodes() -> str:
    """List Jenkins build nodes/agents and their status."""
    data = _get_json(
        "/computer/api/json",
        {"tree": "computer[displayName,description,offline,offlineCauseReason,numExecutors,idle,temporarilyOffline]"},
    )

    nodes = data.get("computer", [])
    if not nodes:
        return "No nodes found."

    lines = ["# Jenkins Nodes"]
    online = sum(1 for n in nodes if not n.get("offline"))
    lines.append(f"Total: {len(nodes)} ({online} online)\n")

    for n in nodes:
        status = "OFFLINE" if n.get("offline") else "online"
        name = n.get("displayName", "?")
        executors = n.get("numExecutors", 0)
        idle = n.get("idle", False)
        line = f"  {name}: {status} ({executors} executors" + (", idle" if idle else "") + ")"
        if n.get("offlineCauseReason"):
            line += f" — {n['offlineCauseReason']}"
        lines.append(line)

    return "\n".join(lines)


if __name__ == "__main__":
    mcp.run()
