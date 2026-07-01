import { GitRepository, repositoryKey } from './gitApi';

export interface PendingGeneratedCommit {
  message: string;
  createdAt: number;
}

export class PendingCommitState {
  private readonly pendingByRepository = new Map<string, PendingGeneratedCommit>();

  public set(repository: GitRepository, pending: PendingGeneratedCommit): void {
    this.pendingByRepository.set(repositoryKey(repository), pending);
  }

  public get(repository: GitRepository): PendingGeneratedCommit | undefined {
    return this.pendingByRepository.get(repositoryKey(repository));
  }

  public clear(repository: GitRepository): void {
    this.pendingByRepository.delete(repositoryKey(repository));
  }
}
