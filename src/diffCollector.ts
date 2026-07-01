import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface DiffCollectOptions {
  repositoryPath: string;
  includeUntracked: boolean;
  maxChars: number;
  output: vscode.OutputChannel;
}

export interface DiffCollectResult {
  diffText: string;
  trackedDiff: string;
  untrackedFiles: string[];
  wasTruncated: boolean;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function runGit(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES
  });

  return result.stdout ?? '';
}

async function getTrackedDiff(repositoryPath: string, output: vscode.OutputChannel): Promise<string> {
  try {
    return await runGit(repositoryPath, ['diff', 'HEAD', '--']);
  } catch (error) {
    output.appendLine(`[diff] git diff HEAD -- failed, fallback to git diff --: ${toErrorMessage(error)}`);
    return runGit(repositoryPath, ['diff', '--']);
  }
}

async function getUntrackedFiles(repositoryPath: string): Promise<string[]> {
  const stdout = await runGit(repositoryPath, ['ls-files', '--others', '--exclude-standard']);
  return stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function truncateDiffText(diffText: string, maxChars: number): { text: string; wasTruncated: boolean } {
  if (diffText.length <= maxChars) {
    return { text: diffText, wasTruncated: false };
  }

  return {
    text: `${diffText.slice(0, maxChars)}\n\n[TRUNCATED]`,
    wasTruncated: true
  };
}

export async function collectDiffForPrompt(options: DiffCollectOptions): Promise<DiffCollectResult> {
  const trackedDiff = await getTrackedDiff(options.repositoryPath, options.output);
  let untrackedFiles: string[] = [];

  if (options.includeUntracked) {
    try {
      untrackedFiles = await getUntrackedFiles(options.repositoryPath);
    } catch (error) {
      options.output.appendLine(`[diff] Failed to read untracked files: ${toErrorMessage(error)}`);
    }
  }

  const sections: string[] = [];
  if (trackedDiff.trim().length > 0) {
    sections.push(`## Tracked Diff\n${trackedDiff.trim()}`);
  }

  if (untrackedFiles.length > 0) {
    const list = untrackedFiles.map((file) => `- ${file}`).join('\n');
    sections.push(`## Untracked Files\n${list}`);
  }

  const combined = sections.join('\n\n');
  if (!combined) {
    return {
      diffText: '',
      trackedDiff,
      untrackedFiles,
      wasTruncated: false
    };
  }

  const { text, wasTruncated } = truncateDiffText(combined, options.maxChars);
  return {
    diffText: text,
    trackedDiff,
    untrackedFiles,
    wasTruncated
  };
}
