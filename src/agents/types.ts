export interface AgentProfile {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  /** `[]` (frontmatter `skills: none`) means "no skills"; undefined keeps full discovery. */
  skills?: string[];
  systemPromptMode?: 'append' | 'replace';
  disableModelInvocation?: boolean;
  systemPrompt: string;
  source: 'user' | 'project';
  filePath: string;
}
