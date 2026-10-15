import { DynamicBorder, type Theme } from '@earendil-works/pi-coding-agent';
import {
  Container,
  fuzzyFilter,
  Input,
  type KeybindingsManager,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
  type TUI,
} from '@earendil-works/pi-tui';

import type { AgentProfile } from '../../agents/types.ts';
import { errorMessage } from '../../utils.ts';

export interface PickerResult {
  readonly agent: AgentProfile;
  readonly model: string | null;
}

export interface PickerData {
  readonly agents: readonly AgentProfile[];
  readonly modelItems: readonly SelectItem[];
  readonly scopedModelItems: readonly SelectItem[];
}

const CLEAR_VALUE = '__clear__';

export class AgentModelPicker extends Container {
  private step: 'agent' | 'model' = 'agent';
  private modelScope: 'scoped' | 'all';
  private searchInput: Input | undefined;
  private selectList: SelectList | undefined;
  private statusLine = new Text('', 0, 0);
  private listIndex = 0;
  private allItems: readonly SelectItem[] = [];
  private agent: AgentProfile | undefined;
  private busy = false;
  private status: { text: string; error: boolean } | undefined;

  get focused(): boolean {
    return this.searchInput?.focused ?? false;
  }

  set focused(value: boolean) {
    if (this.searchInput) this.searchInput.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private data: PickerData,
    private readonly apply: (
      result: PickerResult,
    ) => Promise<PickerData | string>,
    private readonly done: () => void,
  ) {
    super();
    this.modelScope = data.scopedModelItems.length > 0 ? 'scoped' : 'all';
    this.showStep('agent');
  }

  private showStep(step: 'agent' | 'model'): void {
    this.step = step;
    this.allItems =
      step === 'agent'
        ? this.data.agents.map((agent) => ({
            value: agent.name,
            label: agent.name,
            description: [
              agent.model ?? 'Pi default',
              agent.source,
              agent.disableModelInvocation
                ? this.theme.fg('dim', 'disable-model-invocation: true')
                : undefined,
            ]
              .filter(Boolean)
              .join(' · '),
          }))
        : [
            ...(this.modelScope === 'scoped'
              ? this.data.scopedModelItems
              : this.data.modelItems),
            ...(this.agent?.model !== undefined
              ? [
                  {
                    value: CLEAR_VALUE,
                    label: 'clear model',
                    description: 'use Pi default',
                  },
                ]
              : []),
          ];
    const focused = this.focused;
    this.searchInput = new Input({ placeholder: 'type to filter' });
    this.searchInput.focused = focused;
    this.searchInput.onSubmit = () => this.selectList?.handleInput('\r');

    this.clear();
    this.addChild(new DynamicBorder((text) => this.theme.fg('accent', text)));
    this.addChild(
      new Text(
        this.theme.bold(
          this.theme.fg(
            'accent',
            step === 'agent'
              ? 'Herdr agent model · agent'
              : `Herdr agent model · model for ${this.agent?.name ?? ''}`,
          ),
        ),
      ),
    );
    if (step === 'model') {
      this.addChild(
        new Text(
          (['scoped', 'all'] as const)
            .map((scope) => {
              const label = scope === 'scoped' ? 'Scoped' : 'All';
              return this.theme.fg(
                scope === this.modelScope ? 'accent' : 'dim',
                scope === this.modelScope ? `[${label}]` : label,
              );
            })
            .join('  '),
        ),
      );
    }
    this.statusLine = new Text('', 0, 0);
    this.updateStatus();
    this.addChild(this.statusLine);
    this.addChild(new Spacer(1));
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.selectList = this.buildList(this.allItems);
    this.listIndex = this.children.length;
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        this.theme.fg(
          'dim',
          step === 'agent'
            ? 'type to filter · ↑↓ move · enter select · esc close'
            : 'type to filter · ↑↓ move · enter save · tab scope · esc back',
        ),
      ),
    );
    this.addChild(new DynamicBorder((text) => this.theme.fg('accent', text)));
    this.invalidate();
  }

  private updateStatus(): void {
    this.statusLine.setText(
      this.status
        ? this.theme.fg(
            this.status.error ? 'error' : 'success',
            this.status.text,
          )
        : '',
    );
  }

  private buildList(items: readonly SelectItem[]): SelectList {
    const list = new SelectList(
      [...items],
      Math.min(Math.max(items.length, 1), 12),
      {
        selectedPrefix: (text) => this.theme.fg('accent', text),
        selectedText: (text) => this.theme.fg('accent', text),
        description: (text) => this.theme.fg('muted', text),
        scrollInfo: (text) => this.theme.fg('dim', text),
        noMatch: (text) => this.theme.fg('warning', text),
      },
      { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 44 },
    );
    list.onSelect = (item) => {
      if (this.step === 'agent') {
        this.agent = this.data.agents.find(
          (agent) => agent.name === item.value,
        );
        this.showStep('model');
      } else if (this.agent && !this.busy) {
        void this.commit({
          agent: this.agent,
          model: item.value === CLEAR_VALUE ? null : item.value,
        });
      }
    };
    list.onCancel = () => this.onCancel();
    return list;
  }

  private applyFilter(): void {
    const query = this.searchInput?.getValue() ?? '';
    const matches = query
      ? fuzzyFilter(
          [...this.allItems],
          query,
          (item) => `${item.label} ${item.description ?? ''}`,
        )
      : this.allItems;
    this.selectList = this.buildList(matches);
    this.children.splice(this.listIndex, 1, this.selectList);
    this.invalidate();
  }

  private async commit(result: PickerResult): Promise<void> {
    this.busy = true;
    this.status = { text: 'saving…', error: false };
    this.updateStatus();
    this.tui.requestRender();
    try {
      const updated = await this.apply(result);
      if (typeof updated === 'string') {
        this.status = { text: updated, error: true };
      } else {
        this.data = updated;
        this.status = {
          text: `saved ${result.agent.name} → ${result.model ?? 'Pi default'} (${result.agent.filePath})`,
          error: false,
        };
      }
    } catch (error) {
      this.status = { text: errorMessage(error), error: true };
    } finally {
      this.busy = false;
      this.showStep('agent');
      this.tui.requestRender();
    }
  }

  private onCancel(): void {
    if (this.busy) return;
    if (this.step === 'agent') this.done();
    else this.showStep('agent');
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (this.keybindings.matches(data, 'tui.select.cancel')) {
      this.onCancel();
      return;
    }
    if (this.keybindings.matches(data, 'tui.input.tab')) {
      if (this.step === 'model') {
        const query = this.searchInput?.getValue() ?? '';
        this.modelScope = this.modelScope === 'scoped' ? 'all' : 'scoped';
        this.showStep('model');
        this.searchInput?.setValue(query);
        this.applyFilter();
        this.tui.requestRender();
      }
      return;
    }
    const isNavigation = (
      [
        'tui.select.up',
        'tui.select.down',
        'tui.select.pageUp',
        'tui.select.pageDown',
        'tui.select.confirm',
      ] as const
    ).some((action) => this.keybindings.matches(data, action));
    if (isNavigation) this.selectList?.handleInput(data);
    else {
      this.searchInput?.handleInput(data);
      this.applyFilter();
    }
    this.tui.requestRender();
  }
}
