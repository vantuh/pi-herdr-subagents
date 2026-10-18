# Live session cost and refreshing agent manager

## Scope

Show cumulative child-session cost in `/herdr-agents`, align its status column,
and refresh the open modal so new agents and changed metrics appear. Keep the
above-editor widget context-only, the existing timer behavior, and the widened
32..48-column names. No dependencies, configuration, or task-cost accounting.

## Implementation

1. Publish recorded USD cost through the existing child session metadata.
   Sum assistant, tool-result, standalone usage, compaction, and branch-summary
   usage across all session entries, not only the current branch. Recompute the
   total rather than accumulating repeated snapshots, including after resume.
   No recorded usage or an unreadable required cost means unknown; a recorded
   zero remains zero. Optional SDK usage may legitimately be absent.
2. Validate optional display data independently of authoritative session identity.
   Malformed cost must not prevent resume or discard a closed-history record.
   Read context and cost together through `attachAgentMetrics`.
3. Freeze cost in closed history before temporary artifact cleanup. Re-archiving
   replaces the snapshot; only the same child session can retain an older known
   cost when no new sample exists. A reused label cannot inherit another
   session's cost.
4. Render `status • cost • context` for live rows and `status • cost • date`
   for closed rows. Shared plain-text status and cost widths keep separators
   aligned despite ANSI colors. Price precedes longer details to reduce clipping.
   Cost renders as `~$0.024`, `<$0.001`, `~$0.000`, or `cost —`.
5. Rebuild the supported Pi SelectList every second while the modal is open.
   Preserve selection by unique pane ID or closed-history record ID, not tab ID:
   pane-layout siblings share a tab. Resolve actions against the latest listing.
   Opening an empty manager starts the same watching overlay.
6. Avoid overlapping loads and preserve rows on refresh failures. Pass an owned
   abort signal through to state loading. Dispose cancels the timer and closes
   the interaction; normal cleanup and `session_shutdown` await the refresh in
   flight so any state lock is released before shutdown completes.

The installed Pi 1.3.0 SDK supports custom-component disposal, unsubscribing event
handlers, session-entry reads, and SelectList reconstruction. The existing poller
remains the sole owner of detached outcome delivery.

## Verification

- Child publication: all supported usage categories, resume, repeated snapshots,
  measured zero, missing or malformed cost, and compaction.
- Metadata/history: tolerant reads, old records, cost frozen after artifact
  cleanup, same-session re-archive, and different-session label reuse.
- Real manager command flow: an initially empty modal discovers a new agent;
  an open modal updates context/cost and discovers another agent without
  reopening; selected actions resolve the latest pane.
- UI lifecycle: same-tab sibling selection, removed rows, refresh failures,
  timer cleanup, abort propagation, gated shutdown drain, and no post-close render.
- Rendering: shared status widths including `starting`, preserved name bounds,
  and complete cost at an 84-column overlay width.

Commands: `npm run typecheck`, `npm run lint`, `npm run test:unit`,
`npm run test:integration`, `npm run test:e2e`, formatting check, and
`git diff --check`.

## Limits

Cost is Pi's recorded estimate, not actual billing or subscription spend. Metrics
are last-published snapshots, not streaming accounting; idle cache warming may
not appear before a child publishes again. Existing children running older code
publish no cost. No manual TUI session or real-signal shutdown was performed;
shutdown behavior is covered with an abortable gated loader.
