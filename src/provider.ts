import * as vscode from 'vscode';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type ProviderType = 'codex' | 'opencode';

export interface GenerateOptions {
  commandPath: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  output: vscode.OutputChannel;
  onModelFallback?: (requestedModel: string, fallbackModel: string) => void;
}

export type GenerateErrorCode =
  | 'not-found'
  | 'timeout'
  | 'model-access'
  | 'process-failed'
  | 'parse-failed'
  | 'empty-response';

export class GenerateError extends Error {
  constructor(
    public readonly code: GenerateErrorCode,
    message: string,
    public readonly details?: string
  ) {
    super(message);
  }
}

export interface CommitMessageGenerator {
  generate(options: GenerateOptions): Promise<string>;
}
