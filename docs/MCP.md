# The Opsifier MCP server

`opsifier-mcp` lets an AI agent work with a panel through the [Model Context Protocol](https://modelcontextprotocol.io). It is a client of the panel's public API under `/api/v1`, signing every request with an API key. It has no other way in and adds no authority of its own: a call through it can only ever do what the same key could do through the API, and the panel alone decides.

## Install

It needs Node 22.13 or later and is one file with no dependencies. Build it from a checkout:

```sh
bun install
bun run --filter '@opsifier/mcp' build
# packages/mcp/dist/opsifier-mcp.mjs
```

## Connect a client

The server speaks MCP over standard input and output, and reads the panel's address and key from its environment:

```json
{
  "mcpServers": {
    "opsifier": {
      "command": "node",
      "args": ["/path/to/opsifier-mcp.mjs"],
      "env": {
        "OPSIFIER_URL": "https://panel.example.com",
        "OPSIFIER_API_KEY": "opsifier_..."
      }
    }
  }
}
```

With Claude Code: `claude mcp add opsifier -e OPSIFIER_URL=https://panel.example.com -e OPSIFIER_API_KEY=opsifier_... -- node /path/to/opsifier-mcp.mjs`.

**Give an agent the smallest key that will do.** A read-only key is enough for an agent that diagnoses, and a key narrowed to one project is enough for one that deploys it. What the key cannot do, the agent cannot be talked into doing. Log lines and other output are written by applications: an agent should read them as data and never as instructions.

## What it offers

Discovery is filtered: `tools/list` asks the panel what this key may call right now and shows only the tools that will work. Calling a tool that was not listed, or one that became off-limits since, is refused by the panel exactly as the API would refuse the same request.

Every tool carries the standard annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and states how it stands on change and risk in `_meta` as `dev.opsifier/access` (`read`, `change` or `destructive`) and `dev.opsifier/risk` (`low`, `medium` or `high`).

| Tool               | Does                                                             | Access      | Risk   |
| ------------------ | ---------------------------------------------------------------- | ----------- | ------ |
| `whoami`           | Which account and key this is, and what they reach               | read        | low    |
| `list_projects`    | Projects with every service and its state                        | read        | low    |
| `list_services`    | The services of one project                                      | read        | low    |
| `get_service`      | One service: status, replicas, work in progress, source, address | read        | low    |
| `get_service_logs` | Read or search recent logs                                       | read        | low    |
| `list_deployments` | A service's deployments                                          | read        | low    |
| `list_actions`     | What the panel has been doing                                    | read        | low    |
| `get_action`       | One Action, its result and the end of its output                 | read        | low    |
| `deploy_service`   | Deploy a service                                                 | change      | medium |
| `restart_service`  | Restart a service's tasks                                        | change      | medium |
| `start_service`    | Start a stopped service                                          | change      | low    |
| `cancel_action`    | Cancel a queued or running Action                                | change      | medium |
| `stop_service`     | Stop a service (needs `confirm`)                                 | destructive | high   |
| `destroy_service`  | Remove a service (needs `confirm`)                               | destructive | high   |
| `delete_project`   | Delete an empty project (needs `confirm`)                        | destructive | high   |
| `api_operations`   | Search what else this key may call, read, change or destructive  | read        | low    |
| `api_describe`     | Parameters and body of one operation                             | read        | low    |
| `api_get`          | Call any read of the API                                         | read        | medium |
| `api_change`       | Call any change of the API (`confirm` for a destructive one)     | destructive | high   |

Anything slow returns the Action doing the work at once. Read it with `get_action` to see how it went.

## Confirmations

Removing something, taking something offline, restoring, rolling back or revealing a secret can't be taken back, and a model writes every argument of a call. So the server does none of it unless the person who configured it says so, with `OPSIFIER_MCP_ALLOW_DESTRUCTIVE=1` in its environment, next to the key: a model can't change that. Without it, `stop_service`, `destroy_service` and `delete_project` are not listed, and `api_change` refuses such an operation with `destructive_not_allowed`, while it goes on making changes that can be taken back. What an operation is comes from the path the panel routes, however it is spelled.

When it is allowed, each of those does nothing without a `confirm` argument: the exact name of what goes, or for `api_change`, the exact method and path (`DELETE /api/v1/projects/shop/services/web/domains/abc`). An agent should pass it only when the person asked for that change, and a refusal does not repeat what it has to be. It is a brake against a wrong call, not a security boundary; the key's rights are that, and a read-only key is the safest for an agent that reads what others wrote.

## Errors

A tool that fails answers with `isError: true` and a JSON body in the API's own shape, with what to do about it:

```json
{
  "error": {
    "code": "read_only_key",
    "message": "This API key can only read.",
    "status": 403,
    "hint": "This key is limited to reading. Create a key with the write level in Settings, API keys."
  }
}
```

Wrong arguments name the argument, a panel that refuses says why with the panel's own code and message, and a key that was revoked says that as soon as it happens. An unknown tool is a protocol error.

Requests only ever go to `OPSIFIER_URL`: a path is checked to be on this panel's API, and a redirect is refused whatever it points at, so the key cannot follow it elsewhere.
