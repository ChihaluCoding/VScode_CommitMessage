import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { GenerateError, GenerateOptions, ReasoningEffort } from './provider';

export type { ReasoningEffort } from './provider';
export { GenerateError } from './provider';

interface OpencodeJsonEvent {
  type?: string;
  part?: {
    type?: string;
    text?: string;
  };
  error?: {
    name?: string;
    message?: string;
    data?: unknown;
  };
}

interface OpencodeModelCatalogEntry {
  id?: string;
  providerID?: string;
  slug?: string;
  visibility?: string;
  status?: string;
  cost?: {
    input?: number;
    output?: number;
  };
  capabilities?: {
    toolcall?: boolean;
  };
}

function toErrno(error: unknown): NodeJS.ErrnoException {
  return error as NodeJS.ErrnoException;
}

function isNotFoundLikeSpawnError(error: unknown): boolean {
  const errnoError = toErrno(error);
  return errnoError.code === 'ENOENT' || errnoError.code === 'EINVAL';
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

function reasoningEffortToVariant(reasoningEffort: ReasoningEffort): string {
  switch (reasoningEffort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'max';
    default:
      return 'low';
  }
}

function speedPriority(slug: string): number {
  const lowered = slug.toLowerCase();
  if (lowered.includes('flash')) {
    return 0;
  }
  if (lowered.includes('fast')) {
    return 1;
  }
  if (lowered.includes('mini')) {
    return 2;
  }
  if (lowered.includes('free')) {
    return 3;
  }
  return 4;
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
      child = spawn(commandPath, ['models', '--verbose'], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      output.appendLine(`[opencode] Failed to launch model catalog query: ${toErrno(error).message}`);
      resolve([]);
      return;
    }

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      output.appendLine('[opencode] Model catalog query timed out.');
      resolve([]);
    }, 10_000);

    child.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString('utf8');
    });

    child.stderr?.on('data', (data: Buffer) => {
      output.appendLine(`[opencode][catalog stderr] ${data.toString('utf8').trim()}`);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      output.appendLine(`[opencode] Model catalog query failed: ${error.message}`);
      resolve([]);
    });

    child.on('close', () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      const entries: Array<{ slug: string; cost: number; speed: number }> = [];
      const lines = stdoutBuffer.split(/\r?\n/g);
      let i = 0;
      while (i < lines.length) {
        const line = lines[i].trim();
        if (line.length > 0 && !line.startsWith('{')) {
          const slug = line;
          i += 1;
          const block: string[] = [];
          let depth = 0;
          let started = false;
          while (i < lines.length) {
            const current = lines[i];
            if (current.trim().startsWith('{')) {
              started = true;
            }
            if (started) {
              block.push(current);
              depth += (current.match(/{/g) ?? []).length - (current.match(/}/g) ?? []).length;
              if (depth <= 0) {
                break;
              }
            }
            i += 1;
          }

          if (block.length > 0) {
            try {
              const entry = JSON.parse(block.join('\n')) as OpencodeModelCatalogEntry;
              if (entry && (entry.visibility ?? 'list') !== 'hide' && entry.status !== 'deprecated') {
                if (!slug.startsWith('opencode-go/')) {
                  i += 1;
                  continue;
                }
                const cost =
                  (entry.cost?.input ?? Number.POSITIVE_INFINITY) +
                  (entry.cost?.output ?? Number.POSITIVE_INFINITY);
                entries.push({ slug, cost, speed: speedPriority(slug) });
              }
            } catch {
              // skip unparseable entries
            }
          }
          i += 1;
        } else {
          i += 1;
        }
      }

      const sorted = entries
        .sort((a, b) => {
          if (a.cost !== b.cost) {
            return a.cost - b.cost;
          }
          return a.speed - b.speed;
        })
        .map((entry) => entry.slug);

      output.appendLine(
        `[opencode] Model catalog candidates (lowest-cost & fastest first): ${sorted.join(', ')}`
      );
      resolve(sorted);
    });
  });
}

async function runOpencodeWithCommand(
  commandPath: string,
  options: GenerateOptions
): Promise<string> {
  const variant = reasoningEffortToVariant(options.reasoningEffort);
  const args = [
    'run',
    '--format',
    'json',
    '-m',
    options.model,
    '--variant',
    variant,
    options.prompt
  ];

  options.output.appendLine(
    `[opencode] Running: ${commandPath} run --format json -m ${options.model} --variant ${variant} <prompt>`
  );

  return new Promise<string>((resolve, reject) => {
    let stdoutBuffer = '';
    let stdoutRaw = '';
    let stderrRaw = '';
    let lastText: string | undefined;
    let timedOut = false;
    let settled = false;
    let modelAccessDetected = false;

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
            `opencode CLI was not found or not executable at "${commandPath}".`,
            toErrno(error).message
          )
        );
        return;
      }
      reject(new GenerateError('process-failed', `Failed to launch opencode CLI: ${toErrno(error).message}`));
      return;
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      options.output.appendLine(`[opencode] Timed out after ${options.timeoutMs} ms.`);
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

        let event: OpencodeJsonEvent;
        try {
          event = JSON.parse(trimmed) as OpencodeJsonEvent;
        } catch {
          continue;
        }

        if (event.type === 'error') {
          const errorMessage = event.error?.message ?? JSON.stringify(event.error);
          options.output.appendLine(`[opencode] Error event: ${errorMessage}`);
          modelAccessDetected = true;
        }

        if (
          event.type === 'text' &&
          typeof event.part?.text === 'string' &&
          event.part.text.length > 0
        ) {
          lastText = event.part.text;
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
          reject(new GenerateError('not-found', `opencode CLI was not found at "${commandPath}".`));
          return;
        }
        reject(new GenerateError('process-failed', `Failed to launch opencode CLI: ${error.message}`));
      });
    });

    child.on('close', (code) => {
      settle(() => {
        if (stdoutBuffer.trim().length > 0) {
          processStdoutLines('\n');
        }

        if (stderrRaw.trim().length > 0) {
          options.output.appendLine(`[opencode][stderr tail]\n${tail(stderrRaw.trim(), 3000)}`);
        }

        if (stdoutRaw.trim().length > 0) {
          options.output.appendLine(`[opencode][stdout tail]\n${tail(stdoutRaw.trim(), 3000)}`);
        }

        if (timedOut) {
          reject(new GenerateError('timeout', `opencode generation timed out after ${options.timeoutMs} ms.`));
          return;
        }

        if (modelAccessDetected || code !== 0) {
          const combined = `${stderrRaw}\n${stdoutRaw}`;
          if (modelAccessDetected) {
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
              `opencode CLI exited with code ${String(code)}.`,
              tail(combined, 4000)
            )
          );
          return;
        }

        if (!lastText) {
          reject(new GenerateError('parse-failed', 'No agent message was found in opencode JSON output.'));
          return;
        }

        const normalized = normalizeGeneratedMessage(lastText);
        if (!normalized) {
          reject(new GenerateError('empty-response', 'Generated message is empty after normalization.'));
          return;
        }

        resolve(normalized);
      });
    });
  });
}

export async function generateCommitMessageWithOpencode(options: GenerateOptions): Promise<string> {
  let lastNotFoundError: GenerateError | undefined;
  let lastModelAccessError: GenerateError | undefined;

  try {
    return await runOpencodeWithCommand(options.commandPath, options);
  } catch (error) {
    if (error instanceof GenerateError && error.code === 'not-found') {
      lastNotFoundError = error;
      options.output.appendLine(`[opencode] Candidate not available: ${options.commandPath}`);
    } else if (error instanceof GenerateError && error.code === 'model-access') {
      lastModelAccessError = error;
    } else {
      throw error;
    }
  }

  if (lastModelAccessError) {
    const candidates = await getAvailableModelCandidates(options.commandPath, options.output);
    const fallbackModels = candidates.filter((slug) => slug !== options.model);

    options.output.appendLine(
      `[opencode] Model "${options.model}" is inaccessible. Trying fallback models: ${fallbackModels.join(', ')}`
    );

    for (const fallbackModel of fallbackModels) {
      try {
        const result = await runOpencodeWithCommand(options.commandPath, {
          ...options,
          model: fallbackModel
        });
        options.output.appendLine(`[opencode] Fallback succeeded with model: ${fallbackModel}`);
        options.onModelFallback?.(options.model, fallbackModel);
        return result;
      } catch (error) {
        if (error instanceof GenerateError && error.code === 'model-access') {
          options.output.appendLine(`[opencode] Fallback model inaccessible: ${fallbackModel}`);
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
    `opencode CLI was not found at "${options.commandPath}".`,
    'No executable candidate could be resolved.'
  );
}
