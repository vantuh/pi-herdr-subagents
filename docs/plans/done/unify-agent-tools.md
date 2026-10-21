# Unify agent tools

Replace the Herdr-branded LLM surface (`herdr_agent`, `herdr_agent_control`)
with four backend-neutral verb tools, and drop `herdr` from the child protocol,
commands, env vars, message types and user-facing texts.

Motivation: every surveyed comparable extension uses backend-neutral names, and
most converge on spawn / send / stop / status. The current `herdr_agent` has
omission-based modes (no `task` = status check, `resumeClosed` = continue),
which vendor guidance (Anthropic, OpenAI) advises against. Research reports:
`~/.pi/agent/herdr-agents-results/*-toolnames-*.md`, `*-tooldesign-*.md`,
`*-pipocket-*.md`.

## Decisions

- Four separate tools, prefix `agent_`: `agent_spawn`, `agent_send`,
  `agent_stop`, `agent_status`. Separate tools keep per-verb required
  parameters in the schema; no `action` enum, no mode chosen by an omitted
  parameter.
- `tabLabel` becomes `name` everywhere in tool parameters, results and texts.
- No compatibility layer: old tool names, `resumeClosed`, `tabLabel`, old
  markers, env vars, message types and commands are removed, not aliased.
- Out of scope for this plan (phase 2, separate plan, with migration):
  `herdr-agents.json`, `herdr-agents-state.json`, the `herdr-agents-results`
  reports directory. Package name stays as is.

## Tool contract

### `agent_spawn(agent, task, name?)`

Start a fresh one-shot agent. `agent` and `task` are required (non-blank).
`name` defaults to the role-derived label, as `tabLabel` does today.
A `name` that matches a live agent is rejected with a hint to use `agent_send`.
Behavior otherwise equals today's fresh `herdr_agent` spawn.

### `agent_send(name, message)`

Both required. Dispatch by the named agent's state, in this order:

1. Live agent with a parked question: `message` is the answer (today's
   parked-question reuse path, a new prompt turn).
2. Live agent that is working: steer (today's `herdr_agent_control`
   `action: "steer"`, all its guards, ownership check, ack semantics,
   `queued` / `idle` / `unknown` texts).
3. Live agent that is settled with no question (result awaiting delivery):
   refuse with a text saying the result arrives automatically. This is what
   the steer path reports as `idle` today; keep that path's behavior and text,
   adjusted to the new names.
4. No live agent, closed-history record with that exact name: continue it with
   its context (today's `resumeClosed: true` path, all its guards and claim).
5. Otherwise: error naming the unknown agent.

Each path keeps the guards it has today; this plan does not add or remove
guards. If a path needs the profile (`agent`) that today comes from the call,
take it from the stored record; if the record cannot supply it, stop and
report instead of adding a parameter.

### `agent_stop(name)`

Today's `herdr_agent_control` `action: "interrupt"`: abort the current run,
keep the agent open. Same guards, marker order, ack wait and texts (renamed).

### `agent_status(name?)`

- With `name`: today's taskless `herdr_agent` status check (reads the result
  artifact, never the pane).
- Without `name`: new. List the live agents owned by this session
  (`ownerSessionId` equals this session's id): name, profile, status. One
  line per agent; an empty list says so. Read-only, no claim, no prompt.

## Renames

| Old | New |
|---|---|
| `herdr_agent`, `herdr_agent_control` | the four tools above |
| `tabLabel`, `resumeClosed` params | `name`; `resumeClosed` removed |
| `HERDR_RESULT:` | `AGENT_RESULT:` |
| `HERDR_RESULT_FILE:` | `AGENT_RESULT_FILE:` |
| `HERDR_AGENT_CHILD` | `PI_AGENT_CHILD` |
| `HERDR_AGENT_SESSION_META` | `PI_AGENT_SESSION_META` |
| `HERDR_AGENTS_STATE_PATH`, `HERDR_AGENTS_LOCK_WAIT_MS`, `HERDR_AGENTS_CLAIM_LEASE_MS` | `PI_AGENTS_*` |
| `herdr_agent_result`, `herdr_agent_question`, `herdr_agent_steer` custom types | `agent_result`, `agent_question`, `agent_steer` |
| `/herdr-agents` | `/agents` |
| `/herdr-agent-models` | `/agent-models` |
| system prompt section `herdr_agents` | `agents` |
| user/model-facing "Herdr agent X" texts | "Agent X" |

Keep "Herdr" where it names the real backend: Herdr CLI errors, panes, tabs,
workspaces, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, `herdr agent` argv. Internal
identifiers (function and type names like `executeHerdrAgent`) may be renamed
where the file is touched anyway; do not churn untouched files for it.

Accepted effects: messages of the old custom types in existing session files
render without the custom renderer; a child started before `/reload` runs old
child code and old markers, so it may not report correctly until closed.

## Steps

Each step ends green on `npm run typecheck`, `npm run lint`,
`npm run test:unit`, `npm run test:integration`; commit per step.

1. Tools. Replace both registrations with the four tools (new schema module(s)
   under `src/tool/`), route to the existing flows, add `agent_status`
   listing. Rewrite `src/prompts.ts` Orchestrator instructions and tool
   descriptions/guidelines for the new verbs. Update contract and integration
   tests to the new names, params, texts and `details` keys; add tests for
   `agent_send` dispatch order (question, working, settled, closed, unknown),
   `agent_spawn` refusal on a live name, and `agent_status` listing (owned
   only, empty list).
2. Protocol and env. Markers, env vars, custom message types, the system prompt
   section, "Herdr agent" texts. Update child mode, artifacts, harnesses,
   `test-support/`, and the state-path guard.
3. Commands. `/agents`, `/agent-models`; update texts that point to
   `/herdr-agents`.
4. Docs. `README.md`, `docs/tool.md`, `docs/flow.md`, `docs/config.md`,
   `docs/agent-profiles.md`, and `AGENTS.md` (file list, invariants, test
   notes). Do not edit `docs/plans/done/`.
5. `npm run test:e2e` (spawn, delivery and control are touched), then a real
   Pi load check:
   `pi -e ./src/index.ts --no-context-files --no-skills --no-prompt-templates --no-themes -p 'List exact tool names available. Do not use tools.'`
   must list `agent_spawn`, `agent_send`, `agent_stop`, `agent_status` and no
   `herdr_*` tool.

## Phase 2 (separate plan)

Rename `herdr-agents.json`, `herdr-agents-state.json` and the
`herdr-agents-results` directory with a safe one-time migration.
