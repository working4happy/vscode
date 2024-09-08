/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, Event, EventEmitter, FileDecoration, FileDecorationProvider, SourceControlHistoryItem, SourceControlHistoryItemChange, SourceControlHistoryItemGroup, SourceControlHistoryOptions, SourceControlHistoryProvider, ThemeIcon, Uri, window, LogOutputChannel, SourceControlHistoryItemLabel } from 'vscode';
import { Repository, Resource } from './repository';
import { IDisposable, dispose } from './util';
import { toGitUri } from './uri';
import { Branch, LogOptions, RefType } from './api/git';
import { emojify, ensureEmojis } from './emoji';
import { Commit } from './git';

export class GitHistoryProvider implements SourceControlHistoryProvider, FileDecorationProvider, IDisposable {

	private readonly _onDidChangeCurrentHistoryItemGroup = new EventEmitter<void>();
	readonly onDidChangeCurrentHistoryItemGroup: Event<void> = this._onDidChangeCurrentHistoryItemGroup.event;

	private readonly _onDidChangeDecorations = new EventEmitter<Uri[]>();
	readonly onDidChangeFileDecorations: Event<Uri[]> = this._onDidChangeDecorations.event;

	private _currentHistoryItemGroup: SourceControlHistoryItemGroup | undefined;
	get currentHistoryItemGroup(): SourceControlHistoryItemGroup | undefined { return this._currentHistoryItemGroup; }
	set currentHistoryItemGroup(value: SourceControlHistoryItemGroup | undefined) {
		this._currentHistoryItemGroup = value;
		this._onDidChangeCurrentHistoryItemGroup.fire();
	}

	private historyItemDecorations = new Map<string, FileDecoration>();
	private historyItemLabels = new Map<string, ThemeIcon>([
		['HEAD -> refs/heads/', new ThemeIcon('target')],
		['tag: refs/tags/', new ThemeIcon('tag')],
		['refs/heads/', new ThemeIcon('git-branch')],
		['refs/remotes/', new ThemeIcon('cloud')],
	]);

	private disposables: Disposable[] = [];

	constructor(protected readonly repository: Repository, private readonly logger: LogOutputChannel) {
		this.disposables.push(repository.onDidRunGitStatus(() => this.onDidRunGitStatus(), this));
		this.disposables.push(window.registerFileDecorationProvider(this));
	}

	private async onDidRunGitStatus(): Promise<void> {
		if (!this.repository.HEAD) {
			this.logger.trace('[GitHistoryProvider][onDidRunGitStatus] repository.HEAD is undefined');
			this.currentHistoryItemGroup = undefined;
			return;
		}

		// Get the merge base of the current history item group
		const mergeBase = await this.resolveHEADMergeBase();

		// Handle tag, and detached commit
		const currentHistoryItemGroupId =
			this.repository.HEAD.name === undefined ?
				this.repository.HEAD.commit :
				this.repository.HEAD.type === RefType.Tag ?
					`refs/tags/${this.repository.HEAD.name}` :
					`refs/heads/${this.repository.HEAD.name}`;

		// Detached commit
		const currentHistoryItemGroupName =
			this.repository.HEAD.name ?? this.repository.HEAD.commit;

		this.currentHistoryItemGroup = {
			id: currentHistoryItemGroupId ?? '',
			name: currentHistoryItemGroupName ?? '',
			revision: this.repository.HEAD.commit,
			remote: this.repository.HEAD.upstream ? {
				id: `refs/remotes/${this.repository.HEAD.upstream.remote}/${this.repository.HEAD.upstream.name}`,
				name: `${this.repository.HEAD.upstream.remote}/${this.repository.HEAD.upstream.name}`,
				revision: this.repository.HEAD.upstream.commit
			} : undefined,
			base: mergeBase &&
				(mergeBase.remote !== this.repository.HEAD.upstream?.remote ||
					mergeBase.name !== this.repository.HEAD.upstream?.name) ? {
				id: `refs/remotes/${mergeBase.remote}/${mergeBase.name}`,
				name: `${mergeBase.remote}/${mergeBase.name}`,
				revision: mergeBase.commit
			} : undefined
		};

		this.logger.trace(`[GitHistoryProvider][onDidRunGitStatus] currentHistoryItemGroup: ${JSON.stringify(this.currentHistoryItemGroup)}`);
	}

	async provideHistoryItems(options: SourceControlHistoryOptions): Promise<SourceControlHistoryItem[]> {
		if (!this.currentHistoryItemGroup || !options.historyItemGroupIds) {
			return [];
		}

		// Deduplicate refNames
		const refNames = Array.from(new Set<string>(options.historyItemGroupIds));

		let logOptions: LogOptions = { refNames, shortStats: true };

		try {
			if (options.limit === undefined || typeof options.limit === 'number') {
				logOptions = { ...logOptions, maxEntries: options.limit ?? 50 };
			} else if (typeof options.limit.id === 'string') {
				// Get the common ancestor commit, and commits
				const commit = await this.repository.getCommit(options.limit.id);
				const commitParentId = commit.parents.length > 0 ? commit.parents[0] : await this.repository.getEmptyTree();

				logOptions = { ...logOptions, range: `${commitParentId}..` };
			}

			if (typeof options.skip === 'number') {
				logOptions = { ...logOptions, skip: options.skip };
			}

			const commits = await this.repository.log({ ...logOptions, silent: true });

			await ensureEmojis();

			return commits.map(commit => {
				const labels = this.resolveHistoryItemLabels(commit);

				return {
					id: commit.hash,
					parentIds: commit.parents,
					message: emojify(commit.message),
					author: commit.authorName,
					icon: new ThemeIcon('git-commit'),
					displayId: commit.hash.substring(0, 8),
					timestamp: commit.authorDate?.getTime(),
					statistics: commit.shortStat ?? { files: 0, insertions: 0, deletions: 0 },
					labels: labels.length !== 0 ? labels : undefined
				};
			});
		} catch (err) {
			this.logger.error(`[GitHistoryProvider][provideHistoryItems] Failed to get history items with options '${JSON.stringify(options)}': ${err}`);
			return [];
		}
	}

	async provideHistoryItemChanges(historyItemId: string, historyItemParentId: string | undefined): Promise<SourceControlHistoryItemChange[]> {
		historyItemParentId = historyItemParentId ?? await this.repository.getEmptyTree();

		const historyItemChangesUri: Uri[] = [];
		const historyItemChanges: SourceControlHistoryItemChange[] = [];
		const changes = await this.repository.diffTrees(historyItemParentId, historyItemId);

		for (const change of changes) {
			const historyItemUri = change.uri.with({
				query: `ref=${historyItemId}`
			});

			// History item change
			historyItemChanges.push({
				uri: historyItemUri,
				originalUri: toGitUri(change.originalUri, historyItemParentId),
				modifiedUri: toGitUri(change.uri, historyItemId),
				renameUri: change.renameUri,
			});

			// History item change decoration
			const letter = Resource.getStatusLetter(change.status);
			const tooltip = Resource.getStatusText(change.status);
			const color = Resource.getStatusColor(change.status);
			const fileDecoration = new FileDecoration(letter, tooltip, color);
			this.historyItemDecorations.set(historyItemUri.toString(), fileDecoration);

			historyItemChangesUri.push(historyItemUri);
		}

		this._onDidChangeDecorations.fire(historyItemChangesUri);
		return historyItemChanges;
	}

	async resolveHistoryItemGroupCommonAncestor(historyItemGroupIds: string[]): Promise<string | undefined> {
		try {
			if (historyItemGroupIds.length === 0) {
				// TODO@lszomoru - log
				return undefined;
			} else if (historyItemGroupIds.length === 1 && historyItemGroupIds[0] === this.currentHistoryItemGroup?.id) {
				// Remote
				if (this.currentHistoryItemGroup.remote) {
					const ancestor = await this.repository.getMergeBase(historyItemGroupIds[0], this.currentHistoryItemGroup.remote.id);
					return ancestor;
				}

				// Base
				if (this.currentHistoryItemGroup.base) {
					const ancestor = await this.repository.getMergeBase(historyItemGroupIds[0], this.currentHistoryItemGroup.base.id);
					return ancestor;
				}

				// First commit
				const commits = await this.repository.log({ maxParents: 0, refNames: ['HEAD'] });
				if (commits.length > 0) {
					return commits[0].hash;
				}
			} else if (historyItemGroupIds.length > 1) {
				const ancestor = await this.repository.getMergeBase(historyItemGroupIds[0], historyItemGroupIds[1], ...historyItemGroupIds.slice(2));
				return ancestor;
			}
		}
		catch (err) {
			this.logger.error(`[GitHistoryProvider][resolveHistoryItemGroupCommonAncestor] Failed to resolve common ancestor for ${historyItemGroupIds.join(',')}: ${err}`);
		}

		return undefined;
	}

	provideFileDecoration(uri: Uri): FileDecoration | undefined {
		return this.historyItemDecorations.get(uri.toString());
	}

	private resolveHistoryItemLabels(commit: Commit): SourceControlHistoryItemLabel[] {
		const labels: SourceControlHistoryItemLabel[] = [];

		for (const label of commit.refNames) {
			for (const [key, value] of this.historyItemLabels) {
				if (label.startsWith(key)) {
					labels.push({ title: label.substring(key.length), icon: value });
					break;
				}
			}
		}

		return labels;
	}

	private async resolveHEADMergeBase(): Promise<Branch | undefined> {
		if (this.repository.HEAD?.type !== RefType.Head || !this.repository.HEAD?.name) {
			return undefined;
		}

		const mergeBase = await this.repository.getBranchBase(this.repository.HEAD.name);
		return mergeBase;
	}

	dispose(): void {
		dispose(this.disposables);
	}
}
