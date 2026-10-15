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

## Reuse

- `typebox` `Type` already imported in `src/tool/schema.ts`, `src/child.ts`.
- Existing normalizers: `normalizeLayout` (`src/config.ts`),
  `isNonEmptyString` (`src/artifacts.ts`), `normalizeSkillList`
  (`src/agents.ts`).

## Steps

- [ ] `src/json.ts` + unit test (`test/json.test.ts`: non-JSON, wrong shape,
      extra fields allowed, optional wrong type rejected)
- [ ] Herdr schemas in `src/types.ts`; migrate `snapshot.ts`, `agent.ts`,
      `cli.ts`, `placement.ts`, `execute.ts`
- [ ] `config.ts`, `artifacts.ts`
- [ ] `store.ts` state/history schemas, per-record check; add test for
      behavior change 1 (bad optional field drops record, siblings survive)
- [ ] `agents.ts` frontmatter + `utils.ts` `normalizeTools`
- [ ] Remove now-unused hand-written guards (`isLifecycle`, `isLayout`,
      `isClosedHistoryStatus`, local `ParsedAgentGet`-style casts)
- [ ] Fix any existing test that pinned old lenient behavior only where the
      change is one of the accepted ones above

## Verification

- `npm run typecheck`
- `npm test` (contract layer pins malformed-output errors, state-file
  degradation, `details` shape)
- rolldown bundle check from AGENTS.md (confirms `typebox/value` resolves as
  external)
- `npm run test:e2e` once: snapshot/agent-get parsing now validates real Herdr
  `0.9.4` output, which only e2e exercises
- `grep -rn "JSON.parse" src` leaves only `src/json.ts`
