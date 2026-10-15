# Typed JSON parsing with TypeBox

## Context

`JSON.parse` returns `any`. Every call site casts to a hand-written shape and
re-checks fields with `typeof`; some sites only cast (`listTabs`, `pane layout`,
`layout.export`, `tab create` / `pane split`). Types and checks drift apart.

`typebox` is already a peer dependency (dev `1.3.37`, Pi runtime `1.3.27`),
used in `src/tool/schema.ts` and `src/child.ts`. Both versions ship
`typebox/value` (`Value.Check(schema, value): value is Static<schema>`) and
`Type.Cyclic`.

Goal: one TypeBox schema per JSON/`unknown` boundary, TS types derived with
`Static<>`, no parallel hand-written interfaces, no `typeof` chains.

## Decisions

- **Types come from schemas.** `export const PaneInfo = Type.Object(...)` +
  `export type PaneInfo = Static<typeof PaneInfo>` (value and type share one
  name, so existing `import type { PaneInfo }` keeps compiling).
- **Strict on what the code needs, optional for the rest.** Fields the code
  relies on are required; others are `Type.Optional`. Unknown extra fields stay
  allowed (TypeBox default), so new Herdr fields never break us.
- **`Type.Optional` means "absent or correctly typed".** A present field with
  a wrong type fails the whole object. This is the accepted behavior change for
  the state file: today `copyAgentRecords` drops only the bad field; after this
  change the whole record is dropped. Granularity stays per record: one bad
  agent / history record never discards the file or its siblings.
- **`Value.Check`, never `Value.Parse`.** `Parse` runs Convert/Default/Clean and
  would silently coerce (`"1"` to `1`).
- **Input and in-memory shapes differ where defaults exist.** `updatedAt`,
  `createdAt`, `closedAt`, `claimGeneration` are required in the value type
  (`HerdrAgentStateRecord`, `ClosedAgentHistoryRecord`) but optional in the
  reading schema (`HerdrAgentStateRecordInput`, `ClosedAgentHistoryRecordInput`
  built from the same property map with an explicit `required` list). State
  files from older versions may omit them; the defaults (`epoch`, `0`) stay
  code after the check.
- **User config leaves stay untyped** (`Type.Unknown`) because one wrong-typed
  field must not discard its siblings: `layout` switching orphans live agents,
  so `{"layout":"tab","workspace":{"label":42}}` keeps `layout`. Normalization
  (`normalizeLayout`, `normalizeLabel`) is the semantic layer.
- **`CreatedPane` is `PaneInfo` with optional `tab_id`**: `tab create` /
  `pane split` responses may omit it (contract pins the fallback via `listPanes`).
- **Recursive `PortableLayoutNode` uses `Type.Cyclic({ node: … }, 'node')` with
  `Type.Ref('node')`** (definition names, not JSON pointers). `Type.Ref('#/$defs/node')`
  and a pointer `$ref` make `Value.Check` return false. `Static<>` resolves the
  recursion, including nested literal narrowing.
- Builders are functions: `Type.String()`, `Type.Literal('pane')`,
  `Type.Enum(['right','down'])`. `Type.StringLiteral` does not exist in 1.3.37.
  `Static` is a type-only export: `import type { Static } from 'typebox'`.
- **`Type.Any()` replaced by `Type.Unknown()`** so `any` stays out of exported
  types; `agents` uses `Type.Record(Type.String(), Type.Unknown())`.
- **Semantic rules stay as code after the check**: `.trim()`, non-empty after
  trim, `path.isAbsolute`, layout normalization (`" Tab "` to `tab`),
  `updatedAt ?? epoch` defaults. The schema replaces only shape/type checks.
  `Number.isFinite` checks go away (JSON cannot encode non-finite numbers).
- **Error texts stay** (`Malformed Herdr ... output`); contract tests pin two.
  The appended `SyntaxError` message in a few errors is dropped (minor).

## Approach

New `src/json.ts`, one helper:

```ts
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

/** `undefined` when the text is not JSON or does not match the schema. */
export function parseJson<T extends TSchema>(schema: T, text: string): Static<T> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return Value.Check(schema, value) ? value : undefined;
}
```

Throwing sites do `parseJson(...) ?? throwMalformed()`; lenient sites return
their fallback. Non-JSON `unknown` inputs (socket result, Pi message, frontmatter,
array items in the state file) use `Value.Check` directly.

## Files to modify

| File | Change |
|---|---|
| `src/json.ts` | new: `parseJson` |
| `src/types.ts` | `PaneInfo`, `TabInfo`, `WorkspaceInfo`, `HerdrNamedAgent`, `HerdrSessionSnapshot`, `HerdrAgentLayout` become schemas + `Static` types. Non-JSON interfaces (`AgentProfile`, `HerdrAgentInfo`, `HerdrContext`, ...) stay. |
| `src/herdr/snapshot.ts` | `getSessionSnapshot`, `listTabs`, `parseWorkspaceListOutput`, `parseCreatedWorkspace` via response schemas (`{ result: { snapshot } }` etc.). Workspace list keeps per-item filtering (bad item dropped, not whole list) |
| `src/herdr/agent.ts` | `parseAgentGetOutput` via `AgentGetResponse` schema; `ParsedAgentGet` derived |
| `src/herdr/cli.ts` | `parseHerdrError` via `{ error: { code?, message } }`; `execHerdrApi` response line via `{ id?, result?, error?: { message? } }` |
| `src/herdr/placement.ts` | `PortableLayoutNode` via `Type.Cyclic`; `exportPaneLayout` checks `{ layout: { tab_id, root } }`; `PaneLayout` becomes a schema |
| `src/tool/execute.ts` | `tab create` (`result.root_pane: PaneInfo`), `pane split` (`result.pane: PaneInfo`), `pane layout` (`result.layout: PaneLayout`) |
| `src/config.ts` | `HerdrAgentsConfig` schema (`layout?: string`, `workspace?: { label?: string }`); normalization stays |
| `src/artifacts.ts` | `ChildSessionMeta`, `PiSessionHeader` (`type: 'session'` literal) schemas; `assistantText` uses a `{ content: string \| TextPart[] }` schema, filtering non-text parts |
| `src/state/store.ts` | `HerdrAgentStateRecord`, `ClosedAgentHistoryRecord`, `ClosedHistoryStatus` schemas; top-level `{ version, agents?, closedHistory? }` checked loosely, records checked one by one; `isLifecycle`, `isLayout`, `isClosedHistoryStatus` replaced by schema literals |
| `src/agents.ts` | frontmatter schema: `name`, `description` required; `tools`/`skills` `string \| string[]`, `system-prompt`, `disable-model-invocation` `boolean \| string` optional |
| `src/utils.ts` | `normalizeTools` takes `string \| string[] \| undefined` (callers already checked); drops `String(tool)` coercion |

## Behavior changes (accepted)

1. State file: an agent / history record with a wrongly typed optional field is
   dropped instead of losing only that field.
2. Profile frontmatter: a `tools`/`skills` list with non-string items (e.g. a
   YAML number) makes the profile invalid (skipped) instead of being coerced.
   Open: or keep coercion for frontmatter only? (default: strict, per decision)
3. Snapshot: a pane/tab with a wrongly typed known field now fails
   `getSessionSnapshot` ("Malformed Herdr api snapshot response") instead of
   passing through untyped.

4. Workspace list: a workspace item with a wrong-typed `label` keeps its
   `workspace_id` (reader variant `WorkspaceListItem`); only a missing/invalid
   `workspace_id` drops the item.
5. Non-JSON `pane layout` output no longer throws: split-target selection falls
   back to the first managed pane.
6. `readPiSessionHeader` returns `type: 'session'` in its header (test updated).
7. A state file whose `agents` is not an object is now quarantined instead of
   ignored.
8. `layout.export` still requires a non-empty `tab_id` (kept as a semantic
   check; `Type.String()` alone would accept `""`).

## Rejected / left as-is

- `model` and `thinking` in profile frontmatter stay `typeof`-guarded: they are
  not part of the plan's schema and making them strict would skip profiles that
  today load.
- Extra unknown keys in state records are retained on read (`{ ...fields }`).
- `assistantText` envelope allows `Array(Type.Unknown())` so one image part does
  not delete the text parts.

## Reuse

- `typebox` `Type` already imported in `src/tool/schema.ts`, `src/child.ts`.
- Existing normalizers: `normalizeLayout` (`src/config.ts`),
  `isNonEmptyString` (`src/artifacts.ts`), `normalizeSkillList`
  (`src/agents.ts`).

## Steps

- [x] `src/json.ts` + unit test (`test/json.test.ts`: non-JSON, wrong shape,
      extra fields allowed, optional wrong type rejected)
- [x] Herdr schemas in `src/types.ts`; migrate `snapshot.ts`, `agent.ts`,
      `cli.ts`, `placement.ts`, `execute.ts`
- [x] `config.ts`, `artifacts.ts`
- [x] `store.ts` state/history schemas, per-record check; tests for
      behavior change 1 (bad optional field drops record, siblings survive)
      and for the restored defaults (missing `updatedAt`/`createdAt`/`claimGeneration`)
- [x] `agents.ts` frontmatter + `normalizeTools` (it lives in `agents.ts`, not `utils.ts`)
- [x] Remove now-unused hand-written guards (`isLifecycle`, `isLayout`,
      `isClosedHistoryStatus`, local `ParsedAgentGet`-style casts)
- [x] Fix existing tests only where the change is accepted above
- [x] Boundary tests for accepted changes 2 and 3: `test/agents.test.ts`
      (non-string `tools` items skip the profile), `test/contract.test.ts`
      (pane with a wrong-typed `focused` fails `getSessionSnapshot`)

## Verification

Result: `typecheck` clean; unit fast subset 191/191; contract 41/41; e2e 13/13;
integration 80/81 with one pre-existing flake (`status check previews the child
assistant text…` fails 3/7 runs on untouched HEAD too — harness timing, not
parsing). The runtime `typebox` Pi bundles is 1.3.27 (`@earendil-works/pi-ai`
nested copy); `Type.Cyclic`/`Type.Ref`, `Type.Unknown`, `Type.Record`,
`Type.Literal`, `Type.Enum` and `Value.Check` were verified against that copy.

- `npm run typecheck`
- `npm test` (contract layer pins malformed-output errors, state-file
  degradation, `details` shape)
- rolldown bundle check from AGENTS.md (confirms `typebox/value` resolves as
  external)
- `npm run test:e2e` once: snapshot/agent-get parsing now validates real Herdr
  `0.9.4` output, which only e2e exercises
- `grep -rn "JSON.parse" src` leaves only `src/json.ts`
