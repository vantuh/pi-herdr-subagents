/**
 * Fake-only shapes for the in-process Herdr simulator, kept apart from the
 * production schemas so the double cannot couple to the code under test.
 */

export type LayoutNode =
  | { type: 'pane'; pane_id: string }
  | {
      type: 'split';
      direction: 'right' | 'down';
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };

/** A pane split as `pane split` reports it. */
export interface PaneSplit {
  direction: 'right' | 'down';
  ratio: number;
  newPaneId: string;
}

export interface FakePane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  label?: string;
  focused?: boolean;
  agent?: string;
  agent_status?: string;
  cwd?: string;
  env: Record<string, string>;
}

export interface FakeTab {
  tab_id: string;
  label: string;
  focused?: boolean;
}

export interface FakeWorkspace {
  workspace_id: string;
  label?: string;
  focused?: boolean;
  active_tab_id?: string;
}

export interface FakeAgent {
  name: string;
  paneId: string;
  kind: string;
  status: string;
  stateChangeSeq: number;
  completionSeq?: number;
  interactiveReady: boolean;
  piArgs: string[];
  turns: number;
  /** Result artifact from the most recent prompt. */
  resultFile?: string;
  childSessionId?: string;
  childSessionFile?: string;
}

/** What a simulated child does with one prompt. */
export interface ChildOutcome {
  /** Written to the result artifact. */
  result?: string;
  /** Written to question.md instead of finishing (ask_question). */
  question?: string;
  /**
   * How long the child stays `working`. The default is long enough that the
   * extension observes `working` and goes through `herdr agent wait`, which is
   * the real path; a very short one would settle before the first poll.
   */
  delayMs?: number;
  /** Prompt submission never starts a turn. */
  stalled?: boolean;
  /** Never leaves `working`, so waits time out or get aborted. */
  neverSettle?: boolean;
  /** Settle as `done` rather than `idle`. Both mean "finished" to Herdr. */
  settleStatus?: 'idle' | 'done';
  /**
   * Keep reporting the *previous* turn's status and `state_change_seq` for this
   * long after the prompt is submitted, before starting the new turn.
   *
   * Reproduces the reused-agent race: a persistent child still exposes its
   * prior settled state, and a poller that accepts any `idle` would collect the
   * previous turn's output as if it answered the new prompt.
   */
  staleWindowMs?: number;
}

export interface ChildTurn {
  prompt: string;
  resultFile?: string;
  agentName: string;
  paneId: string;
  /** 1 for the first prompt this agent receives. */
  turn: number;
}

export type ChildBehavior = (
  turn: ChildTurn,
) => ChildOutcome | Promise<ChildOutcome>;

export interface CliResponse {
  stdout?: string;
  stderr?: string;
  code?: number;
}
