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

/**
 * How the simulated child answers a control request: the `queued`/`idle`
 * reply to a steer, the `aborted`/`requested` reply to an interrupt, or `none`
 * for a child that never answers (a parent-side timeout).
 */
export type ChildControlAck =
  | 'queued'
  | 'idle'
  | 'none'
  | 'aborted'
  | 'requested';

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
  /** Context sample the simulated child publishes in `session.json`. */
  childContext?: { tokens: number | null; contextWindow: number };
  /** Cumulative cost the simulated child publishes in `session.json`. */
  childCost?: number;
  /** Reply the simulated control consumer gives to the next control request. */
  controlAck?: ChildControlAck;
  /** Steer texts the simulated child applied during this run. */
  steerTexts?: string[];
  /** Control directory the simulated child is currently consuming. */
  controlDir?: string;
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
  /**
   * Context sample published in `session.json` after this turn, as a real child
   * publishes one at `turn_end`. Omit it to publish metadata without a sample,
   * which is what a new assignment or a fresh child does.
   */
  context?: { tokens: number | null; contextWindow: number };
  /**
   * Cumulative cost published in `session.json` after this turn, as a real
   * child publishes the sum of its recorded usage. Omit it for a child that
   * recorded no cost-bearing usage.
   */
  cost?: number;
  /**
   * How the simulated child answers a control request (`control/request.json`)
   * while it lives: `queued` applies a steer and appends its text to the
   * result, `aborted`/`requested` write the interrupted marker (aborting the
   * run for `aborted`), `idle` refuses, `none` never answers.
   */
  controlAck?: ChildControlAck;
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
