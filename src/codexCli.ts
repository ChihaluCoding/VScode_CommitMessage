import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { GenerateError, GenerateOptions, ReasoningEffort } from './provider';

export type { ReasoningEffort } from './provider';
export { GenerateError } from './provider';
export type CodexGenerateOptions = GenerateOptions;

interface CodexJsonEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

interface CatalogModel {
  slug?: string;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
}

interface CatalogDocument {
  models?: CatalogModel[];
}

function toErrno(error: unknown): NodeJS.ErrnoException {
  return error as NodeJS.ErrnoException;
}

function isNotFoundLikeSpawnError(error: unknown): boolean {
  const errnoError = toErrno(error);
  return errnoError.code === 'ENOENT' || errnoError.code === 'EINVAL';
}

function uniqueCommandPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const commandPath of paths) {
    const normalized = process.platform === 'win32' ? commandPath.toLowerCase() : commandPath;
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    results.push(commandPath);
  }

  return results;
}

function getBundledWindowsCodexCandidates(): string[] {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) {
    return [];
  }

  const extensionRoots = [
    path.join(userProfile, '.vscode', 'extensions'),
    path.join(userProfile, '.vscode-insiders', 'extensions')
  ];

  const candidates: string[] = [];
  for (const root of extensionRoots) {
    if (!fs.existsSync(root)) {
      continue;
    }

    let directories: fs.Dirent[];
    try {
      directories = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const directory of directories) {
      if (!directory.isDirectory()) {
        continue;
      }

      if (!directory.name.startsWith('openai.chatgpt-')) {
        continue;
      }

      candidates.push(path.join(root, directory.name, 'bin', 'windows-x86_64', 'codex.exe'));
    }
  }

  return candidates;
}

function buildCommandCandidates(configuredCommandPath: string): string[] {
  const commandPath = configuredCommandPath.trim();
  const candidates: string[] = [commandPath];

  if (process.platform === 'win32') {
    if (/\.(cmd|bat|ps1)$/i.test(commandPath)) {
      candidates.push(commandPath.replace(/\.(cmd|bat|ps1)$/i, ''));
      candidates.push(commandPath.replace(/\.(cmd|bat|ps1)$/i, '.exe'));
    }

    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push(path.join(appData, 'npm', 'codex'));
      candidates.push(path.join(appData, 'npm', 'codex.exe'));
    }

    candidates.push(...getBundledWindowsCodexCandidates());
  }

  const filtered = candidates.filter((candidate) => {
    if (!candidate) {
      return false;
    }

    if (!path.isAbsolute(candidate)) {
      return true;
    }

    return fs.existsSync(candidate);
  });

  return uniqueCommandPaths(filtered);
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(text.length - maxChars);
}

function normalizeGeneratedMessage(raw: string): string {
  const firstLine =
    raw
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';

  return firstLine.replace(/^["'`]+|["'`]+$/g, '').trim();
}

function isModelAccessError(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    lowered.includes('does not exist or you do not have access') ||
    lowered.includes('do not have access to it') ||
    lowered.includes('is not supported')
  );
}

async function runCodexWithCommand(
  commandPath: string,
  options: CodexGenerateOptions
): Promise<string> {
  const args = [
    'exec',
    '--json',
    '-m',
    options.model,
    '-c',
    `model_reasoning_effort="${options.reasoningEffort}"`,
    options.prompt
  ];

  options.output.appendLine(
    `[codex] Running: ${commandPath} exec --json -m ${options.model} -c model_reasoning_effort="${options.reasoningEffort}" <prompt>`
  );

  return new Promise<string>((resolve, reject) => {
    let stdoutBuffer = '';
    let stdoutRaw = '';
    let stderrRaw = '';
    let lastAgentMessage: string | undefined;
    let timedOut = false;
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(commandPath, args, {
        cwd: options.cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      if (isNotFoundLikeSpawnError(error)) {
        reject(
          new GenerateError(
            'not-found',
            `Codex CLI was not found or not executable at "${commandPath}".`,
            toErrno(error).message
          )
        );
        return;
      }

      reject(new GenerateError('process-failed', `Failed to launch Codex CLI: ${toErrno(error).message}`));
      return;
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      options.output.appendLine(`[codex] Timed out after ${options.timeoutMs} ms.`);
      child.kill();
    }, options.timeoutMs);

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      callback();
    };

    const processStdoutLines = (chunk: string): void => {
      stdoutRaw += chunk;
      stdoutBuffer += chunk;

      const lines = stdoutBuffer.split(/\r?\n/g);
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let event: CodexJsonEvent;
        try {
          event = JSON.parse(trimmed) as CodexJsonEvent;
        } catch {
          continue;
        }

        if (
          event.type === 'item.completed' &&
          event.item?.type === 'agent_message' &&
          typeof event.item.text === 'string'
        ) {
          lastAgentMessage = event.item.text;
        }
      }
    };

    child.stdout?.on('data', (data: Buffer) => {
      processStdoutLines(data.toString('utf8'));
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderrRaw += data.toString('utf8');
    });

    child.on('error', (error) => {
      settle(() => {
        if (isNotFoundLikeSpawnError(error)) {
          reject(new GenerateError('not-found', `Codex CLI was not found at "${commandPath}".`));
          return;
        }

        reject(new GenerateError('process-failed', `Failed to launch Codex CLI: ${error.message}`));
      });
    });

    child.on('close', (code) => {
      settle(() => {
        if (stdoutBuffer.trim().length > 0) {
          processStdoutLines('\n');
        }

        if (stderrRaw.trim().length > 0) {
          options.output.appendLine(`[codex][stderr tail]\n${tail(stderrRaw.trim(), 3000)}`);
        }

        if (stdoutRaw.trim().length > 0) {
          options.output.appendLine(`[codex][stdout tail]\n${tail(stdoutRaw.trim(), 3000)}`);
        }

        if (timedOut) {
          reject(new GenerateError('timeout', `Codex generation timed out after ${options.timeoutMs} ms.`));
          return;
        }

        if (code !== 0) {
          const combined = `${stderrRaw}\n${stdoutRaw}`;
          if (isModelAccessError(combined)) {
            reject(
              new GenerateError(
                'model-access',
                `Model access error for "${options.model}".`,
                tail(combined, 4000)
              )
            );
            return;
          }

          reject(
            new GenerateError(
              'process-failed',
              `Codex CLI exited with code ${String(code)}.`,
              tail(combined, 4000)
            )
          );
          return;
        }

        if (!lastAgentMessage) {
          reject(new GenerateError('parse-failed', 'No agent message was found in Codex JSON output.'));
          return;
        }

        const normalized = normalizeGeneratedMessage(lastAgentMessage);
        if (!normalized) {
          reject(new GenerateError('empty-response', 'Generated message is empty after normalization.'));
          return;
        }

        resolve(normalized);
      });
    });
  });
}

async function getAvailableModelCandidates(
  commandPath: string,
  output: vscode.OutputChannel
): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    let stdoutBuffer = '';
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(commandPath, ['debug', 'models', '--bundled'], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      output.appendLine(`[codex] Failed to launch model catalog query: ${toErrno(error).message}`);
      resolve([]);
      return;
    }

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      output.appendLine('[codex] Model catalog query timed out.');
      resolve([]);
    }, 10_000);

    child.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString('utf8');
    });

    child.stderr?.on('data', (data: Buffer) => {
      output.appendLine(`[codex][catalog stderr] ${data.toString('utf8').trim()}`);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      output.appendLine(`[codex] Model catalog query failed: ${error.message}`);
      resolve([]);
    });

    child.on('close', () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      let document: CatalogDocument;
      try {
        document = JSON.parse(stdoutBuffer) as CatalogDocument;
      } catch (error) {
        output.appendLine(`[codex] Failed to parse model catalog JSON: ${toErrno(error).message}`);
        resolve([]);
        return;
      }

      const models = document.models ?? [];
      const candidates = models
        .filter(
          (model) =>
            model.visibility === 'list' &&
            model.supported_in_api === true &&
            typeof model.slug === 'string' &&
            model.slug.length > 0
        )
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        .map((model) => model.slug as string);

      output.appendLine(`[codex] Model catalog candidates (lowest-capability first): ${candidates.join(', ')}`);
      resolve(candidates);
    });
  });
}

export async function generateCommitMessageWithCodex(options: CodexGenerateOptions): Promise<string> {
  const commandCandidates = buildCommandCandidates(options.commandPath);
  let lastNotFoundError: GenerateError | undefined;
  let lastModelAccessError: GenerateError | undefined;
  let resolvedCommandPath: string | undefined;

  for (const commandPath of commandCandidates) {
    try {
      return await runCodexWithCommand(commandPath, options);
    } catch (error) {
      if (error instanceof GenerateError && error.code === 'not-found') {
        lastNotFoundError = error;
        options.output.appendLine(`[codex] Candidate not available: ${commandPath}`);
        continue;
      }

      if (error instanceof GenerateError && error.code === 'model-access') {
        lastModelAccessError = error;
        resolvedCommandPath = commandPath;
        break;
      }

      throw error;
    }
  }

  if (lastModelAccessError && resolvedCommandPath) {
    const candidates = await getAvailableModelCandidates(resolvedCommandPath, options.output);
    const fallbackModels = candidates.filter((slug) => slug !== options.model);

    options.output.appendLine(
      `[codex] Model "${options.model}" is inaccessible. Trying fallback models: ${fallbackModels.join(', ')}`
    );

    for (const fallbackModel of fallbackModels) {
      try {
        const result = await runCodexWithCommand(resolvedCommandPath, { ...options, model: fallbackModel });
        options.output.appendLine(`[codex] Fallback succeeded with model: ${fallbackModel}`);
        options.onModelFallback?.(options.model, fallbackModel);
        return result;
      } catch (error) {
        if (error instanceof GenerateError && error.code === 'model-access') {
          options.output.appendLine(`[codex] Fallback model inaccessible: ${fallbackModel}`);
          lastModelAccessError = error;
          continue;
        }

        throw error;
      }
    }
  }

  if (lastModelAccessError) {
    throw lastModelAccessError;
  }

  if (lastNotFoundError) {
    throw lastNotFoundError;
  }

  throw new GenerateError(
    'not-found',
    `Codex CLI was not found at "${options.commandPath}".`,
    'No executable candidate could be resolved.'
  );
}
