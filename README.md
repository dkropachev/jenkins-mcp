# Jenkins MCP Server

MCP (Model Context Protocol) server for interacting with Jenkins at `jenkins.scylladb.com`. Provides tools for listing jobs, viewing builds, reading console output, triggering builds, and more.

## Setup

### Prerequisites

```bash
npm install
```

### Credentials

The server uses these environment variables for authentication:

| Variable | Required | Description |
|---|---|---|
| `JENKINS_USER` | Yes | Your Jenkins username |
| `JENKINS_TOKEN` | Yes | Your Jenkins API token |
| `JENKINS_URL` | No | Jenkins base URL (default: `https://jenkins.scylladb.com`) |

#### Step 1: Get your Jenkins username

Your Jenkins username is the same as your ScyllaDB LDAP / SSO username. You can verify it by logging in to https://jenkins.scylladb.com and checking the name shown in the top-right corner.

#### Step 2: Generate an API token

1. Log in to https://jenkins.scylladb.com
2. Click your name in the top-right corner → **Configure** (or go directly to `https://jenkins.scylladb.com/user/<your-username>/configure`)
3. Scroll down to the **API Token** section
4. Click **Add new Token**, give it a descriptive name (e.g. `claude-code-mcp`), and click **Generate**
5. Copy the token immediately — it is shown only once

#### Step 3: Verify access

Test that your credentials work:

```bash
curl -u "your-username:your-api-token" https://jenkins.scylladb.com/api/json?tree=mode
```

You should see `{"mode":"NORMAL"}` (or similar). If you get a 401/403, double-check your username and token.

### Adding to Claude Code

Add the server to your Claude Code MCP configuration. Edit (or create) the file `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "node",
      "args": ["/path/to/jenkins-mcp/server.js"],
      "env": {
        "JENKINS_USER": "your-username",
        "JENKINS_TOKEN": "your-api-token"
      }
    }
  }
}
```

Replace `/path/to/jenkins-mcp/server.js` with the absolute path to `server.js`, and fill in your credentials. `JENKINS_URL` defaults to `https://jenkins.scylladb.com` and can be omitted.

You can also configure it at the project level by creating a `.mcp.json` file in the project root (this format is shared with OpenAI Codex):

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "node",
      "args": ["./server.js"],
      "env": {
        "JENKINS_USER": "your-username",
        "JENKINS_TOKEN": "your-api-token"
      }
    }
  }
}
```

### Adding to OpenAI Codex

Codex uses the same `.mcp.json` project-level configuration as Claude Code (see above). Place the `.mcp.json` file in the project root and Codex will pick it up automatically.

### Running Standalone (for testing)

```bash
JENKINS_USER=your-username JENKINS_TOKEN=your-api-token node server.js
```

The server communicates over stdio using the MCP protocol — it is not meant to be used directly from a terminal, but this verifies it starts without errors.

## Development

### Linting

```bash
npm run lint
```

Uses [ESLint 9](https://eslint.org/) with flat config (`eslint.config.js`).

### CI/CD

GitHub Actions runs on every push and PR to `main`:
- **Lint** — `npx eslint .` with Node 20

## Driver Tests Overview

The Jenkins folder [`scylla-master/driver-tests`](https://jenkins.scylladb.com/view/*/job/*/job/driver-tests/) contains CI jobs that test ScyllaDB compatibility with various CQL client drivers.

### How Driver Tests Work

Each driver test job:
1. Spins up a ScyllaDB cluster (typically via [CCM](https://github.com/scylladb/scylla-ccm))
2. Runs the driver's test suite against it across multiple driver versions and protocol versions
3. Reports results to [Argus](https://argus.scylladb.com)

The test infrastructure for each driver lives in a **driver-matrix** repo. These repos contain the configuration (which driver versions to test, which tests to run, version-specific workarounds, etc.). The actual driver source code lives in separate **driver** repos — ScyllaDB forks of upstream drivers (or ScyllaDB-native drivers in the case of Rust).

### Job → Repository Mapping

| Jenkins Job | Driver Matrix Repo (test infra) | ScyllaDB Driver Repo (fork) | Upstream Driver Repo |
|---|---|---|---|
| [`cpp-driver-matrix-test`](https://jenkins.scylladb.com/job/scylla-master/job/driver-tests/job/cpp-driver-matrix-test/) | [scylladb/scylla-cpp-driver-matrix](https://github.com/scylladb/scylla-cpp-driver-matrix) | [scylladb/cpp-driver](https://github.com/scylladb/cpp-driver) | [apache/cassandra-cpp-driver](https://github.com/apache/cassandra-cpp-driver) |
| [`csharp-driver-matrix-test`](https://jenkins.scylladb.com/job/scylla-master/job/driver-tests/job/csharp-driver-matrix-test/) | [scylladb/csharp-driver-matrix](https://github.com/scylladb/csharp-driver-matrix) | [scylladb/csharp-driver](https://github.com/scylladb/csharp-driver) | [datastax/csharp-driver](https://github.com/datastax/csharp-driver) |
| [`gocql-driver-matrix-test`](https://jenkins.scylladb.com/job/scylla-master/job/driver-tests/job/gocql-driver-matrix-test/) | [scylladb/gocql-driver-matrix](https://github.com/scylladb/gocql-driver-matrix) | [scylladb/gocql](https://github.com/scylladb/gocql) | [apache/cassandra-gocql-driver](https://github.com/apache/cassandra-gocql-driver) |
| [`java-driver-matrix-test`](https://jenkins.scylladb.com/job/scylla-master/job/driver-tests/job/java-driver-matrix-test/) | [scylladb/scylla-java-driver-matrix](https://github.com/scylladb/scylla-java-driver-matrix) | [scylladb/java-driver](https://github.com/scylladb/java-driver) | [apache/cassandra-java-driver](https://github.com/apache/cassandra-java-driver) |
| [`python-driver-matrix-test`](https://jenkins.scylladb.com/job/scylla-master/job/driver-tests/job/python-driver-matrix-test/) | [scylladb/python-driver-matrix](https://github.com/scylladb/python-driver-matrix) | [scylladb/python-driver](https://github.com/scylladb/python-driver) | [apache/cassandra-python-driver](https://github.com/apache/cassandra-python-driver) |
| [`rust-driver-matrix-test`](https://jenkins.scylladb.com/job/scylla-master/job/driver-tests/job/rust-driver-matrix-test/) | [scylladb/scylla-rust-driver-matrix](https://github.com/scylladb/scylla-rust-driver-matrix) | [scylladb/scylla-rust-driver](https://github.com/scylladb/scylla-rust-driver) | N/A (ScyllaDB-native) |

### Where to File Issues

- **Test infrastructure issues** (flaky tests, missing versions, matrix config problems) → file in the **driver-matrix** repo
- **Driver bugs** (incorrect behavior, crashes, protocol issues) → file in the **driver** repo
- **ScyllaDB server bugs** (discovered via driver tests) → file in [scylladb/scylladb](https://github.com/scylladb/scylladb)

### Available MCP Tools

| Tool | Description |
|---|---|
| `list_jobs` | List jobs in a folder |
| `get_job_info` | Get detailed job info including parameters |
| `get_build_info` | Get info about a specific build |
| `get_console_output` | Get build console output (with optional tail) |
| `get_build_log_section` | Search console output with regex and context |
| `list_builds` | List recent builds for a job |
| `trigger_build` | Trigger a new build |
| `stop_build` | Abort a running build |
| `get_queue` | View the build queue |
| `list_views` | List Jenkins views |
| `get_view_jobs` | List jobs in a view |
| `search_jobs` | Search for jobs by name |
| `get_nodes` | List build nodes/agents |
