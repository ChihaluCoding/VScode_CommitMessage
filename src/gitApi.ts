import * as path from 'path';
import * as vscode from 'vscode';

export interface GitBranch {
  readonly name?: string;
  readonly commit?: string;
}

export interface GitCommit {
  readonly hash: string;
  readonly message: string;
}

export interface GitCommitOptions {
  all?: boolean | 'tracked';
  amend?: boolean;
  signoff?: boolean;
  signCommit?: boolean;
  empty?: boolean;
  noVerify?: boolean;
  requireUserConfig?: boolean;
  useEditor?: boolean;
  verbose?: boolean;
  postCommitCommand?: string | null;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
  readonly state: { readonly HEAD: GitBranch | undefined };
  readonly ui: { readonly selected: boolean };
  readonly onDidCommit: vscode.Event<void>;
  commit(message: string, opts?: GitCommitOptions): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
  getCommit(ref: string): Promise<GitCommit>;
}

export interface GitAPI {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  getAPI(version: 1): GitAPI;
}

function isGitExtension(value: unknown): value is GitExtension {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return typeof (value as { getAPI?: unknown }).getAPI === 'function';
}

function isRepository(value: unknown): value is GitRepository {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<GitRepository>;
  return (
    typeof candidate.commit === 'function' &&
    typeof candidate.push === 'function' &&
    typeof candidate.getCommit === 'function' &&
    typeof candidate.onDidCommit === 'function' &&
    typeof candidate.rootUri === 'object' &&
    candidate.rootUri !== null
  );
}

function normalizeFsPath(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  if (process.platform === 'win32') {
    return normalized.toLowerCase();
  }

  return normalized;
}

export function repositoryKey(repository: GitRepository): string {
  return normalizeFsPath(repository.rootUri.fsPath);
}

export async function getGitApi(): Promise<GitAPI> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    throw new Error('VS Code Git extension was not found.');
  }

  const extensionExports = extension.isActive ? extension.exports : await extension.activate();
  if (!isGitExtension(extensionExports)) {
    throw new Error('VS Code Git extension API is unavailable.');
  }

  return extensionExports.getAPI(1);
}

function findRepositoryByRootUri(api: GitAPI, rootUri: vscode.Uri): GitRepository | undefined {
  const targetPath = normalizeFsPath(rootUri.fsPath);
  return api.repositories.find((repo) => repositoryKey(repo) === targetPath);
}

function tryResolveRepositoryFromArg(api: GitAPI, contextArg: unknown): GitRepository | undefined {
  if (!contextArg) {
    return undefined;
  }

  if (isRepository(contextArg)) {
    return contextArg;
  }

  if (typeof contextArg !== 'object') {
    return undefined;
  }

  const argObject = contextArg as Record<string, unknown>;

  if (argObject.rootUri instanceof vscode.Uri) {
    return findRepositoryByRootUri(api, argObject.rootUri);
  }

  const uriCandidateKeys = ['resourceUri', 'uri', 'sourceUri'];
  for (const key of uriCandidateKeys) {
    const uriValue = argObject[key];
    if (uriValue instanceof vscode.Uri) {
      const repository = api.getRepository(uriValue);
      if (repository) {
        return repository;
      }
    }
  }

  return undefined;
}

interface RepositoryQuickPickItem extends vscode.QuickPickItem {
  readonly repository: GitRepository;
}

export async function resolveRepository(api: GitAPI, contextArg: unknown): Promise<GitRepository | undefined> {
  const fromArg = tryResolveRepositoryFromArg(api, contextArg);
  if (fromArg) {
    return fromArg;
  }

  const selectedRepositories = api.repositories.filter((repo) => repo.ui?.selected);
  if (selectedRepositories.length === 1) {
    return selectedRepositories[0];
  }

  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  if (activeEditorUri) {
    const fromActiveEditor = api.getRepository(activeEditorUri);
    if (fromActiveEditor) {
      return fromActiveEditor;
    }
  }

  if (api.repositories.length === 1) {
    return api.repositories[0];
  }

  if (api.repositories.length === 0) {
    return undefined;
  }

  const items: RepositoryQuickPickItem[] = api.repositories.map((repository) => ({
    label: path.basename(repository.rootUri.fsPath),
    description: repository.rootUri.fsPath,
    repository
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'commitMessage生成の対象リポジトリを選択'
  });

  return picked?.repository;
}
