/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/scm.css';
import * as platform from '../../../../base/common/platform.js';
import { $, append, h, reset } from '../../../../base/browser/dom.js';
import { IHoverOptions, IManagedHoverTooltipMarkdownString } from '../../../../base/browser/ui/hover/hover.js';
import { IHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { IconLabel } from '../../../../base/browser/ui/iconLabel/iconLabel.js';
import { IIdentityProvider, IKeyboardNavigationLabelProvider, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { LabelFuzzyScore } from '../../../../base/browser/ui/tree/abstractTree.js';
import { IAsyncDataSource, ITreeContextMenuEvent, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { fromNow } from '../../../../base/common/date.js';
import { createMatches, FuzzyScore, IMatch } from '../../../../base/common/filters.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, autorunWithStore, autorunWithStoreHandleChanges, derived, derivedOpts, IObservable, observableValue } from '../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenEvent, WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { asCssVariable, ColorIdentifier, foreground } from '../../../../platform/theme/common/colorRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewAction, ViewPane, ViewPaneShowActions } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { renderSCMHistoryItemGraph, historyItemGroupLocal, historyItemGroupRemote, historyItemGroupBase, toISCMHistoryItemViewModelArray, SWIMLANE_WIDTH, renderSCMHistoryGraphPlaceholder, historyItemHoverDeletionsForeground, historyItemHoverLabelForeground, historyItemHoverAdditionsForeground, historyItemHoverDefaultLabelForeground, historyItemHoverDefaultLabelBackground } from './scmHistory.js';
import { isSCMHistoryItemLoadMoreTreeElement, isSCMHistoryItemViewModelTreeElement, isSCMRepository } from './util.js';
import { ISCMHistoryItem, ISCMHistoryItemGroup, ISCMHistoryItemViewModel, SCMHistoryItemLoadMoreTreeElement, SCMHistoryItemViewModelTreeElement } from '../common/history.js';
import { HISTORY_VIEW_PANE_ID, ISCMProvider, ISCMRepository, ISCMService, ISCMViewService } from '../common/scm.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { stripIcons } from '../../../../base/common/iconLabels.js';
import { IWorkbenchLayoutService, Position } from '../../../services/layout/browser/layoutService.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Sequencer, Throttler } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ActionRunner, IAction, IActionRunner } from '../../../../base/common/actions.js';
import { tail } from '../../../../base/common/arrays.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IProgressService } from '../../../../platform/progress/common/progress.js';
import { constObservable, derivedConstOnceDefined, latestChangedValue, observableFromEvent } from '../../../../base/common/observableInternal/utils.js';
import { ContextKeys } from './scmViewPane.js';
import { IActionViewItem } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IDropdownMenuActionViewItemOptions } from '../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { ActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { Event } from '../../../../base/common/event.js';
import { Iterable } from '../../../../base/common/iterator.js';
import { clamp } from '../../../../base/common/numbers.js';
import { observableConfigValue } from '../../../../platform/observable/common/platformObservableUtils.js';
import { structuralEquals } from '../../../../base/common/equals.js';

type TreeElement = SCMHistoryItemViewModelTreeElement | SCMHistoryItemLoadMoreTreeElement;

class SCMRepositoryActionViewItem extends ActionViewItem {
	constructor(private readonly _repository: ISCMRepository, action: IAction, options?: IDropdownMenuActionViewItemOptions) {
		super(null, action, { ...options, icon: false, label: true });
	}

	protected override updateLabel(): void {
		if (this.options.label && this.label) {
			this.label.classList.add('scm-graph-repository-picker');
			reset(this.label, ...renderLabelWithIcons(`$(repo) ${this._repository.provider.name}`));
		}
	}
}

registerAction2(class extends ViewAction<SCMHistoryViewPane> {
	constructor() {
		super({
			id: 'workbench.scm.action.repository',
			title: '',
			viewId: HISTORY_VIEW_PANE_ID,
			f1: false,
			menu: {
				id: MenuId.SCMHistoryTitle,
				when: ContextKeyExpr.and(ContextKeyExpr.has('scm.providerCount'), ContextKeyExpr.greater('scm.providerCount', 1)),
				group: 'navigation',
				order: 0
			}
		});
	}

	async runInView(_: ServicesAccessor, view: SCMHistoryViewPane): Promise<void> {
		view.pickRepository();
	}
});

registerAction2(class extends ViewAction<SCMHistoryViewPane> {
	constructor() {
		super({
			id: 'workbench.scm.action.refreshGraph',
			title: localize('refreshGraph', "Refresh"),
			viewId: HISTORY_VIEW_PANE_ID,
			f1: false,
			icon: Codicon.refresh,
			menu: {
				id: MenuId.SCMHistoryTitle,
				group: 'navigation',
				order: 1000
			}
		});
	}

	async runInView(_: ServicesAccessor, view: SCMHistoryViewPane): Promise<void> {
		view.refresh();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.scm.viewChanges',
			title: localize('viewChanges', "View Changes"),
			f1: false,
			menu: [
				{
					id: MenuId.SCMChangesContext,
					group: '0_view',
					when: ContextKeyExpr.equals('config.multiDiffEditor.experimental.enabled', true)
				}
			]
		});
	}

	override async run(accessor: ServicesAccessor, provider: ISCMProvider, ...historyItems: ISCMHistoryItem[]) {
		const commandService = accessor.get(ICommandService);

		if (!provider || historyItems.length === 0) {
			return;
		}

		const historyItem = historyItems[0];
		const historyItemLast = historyItems[historyItems.length - 1];
		const historyProvider = provider.historyProvider.get();

		if (historyItems.length > 1) {
			const ancestor = await historyProvider?.resolveHistoryItemGroupCommonAncestor([historyItem.id, historyItemLast.id]);
			if (!ancestor || (ancestor !== historyItem.id && ancestor !== historyItemLast.id)) {
				return;
			}
		}

		const historyItemParentId = historyItemLast.parentIds.length > 0 ? historyItemLast.parentIds[0] : undefined;
		const historyItemChanges = await historyProvider?.provideHistoryItemChanges(historyItem.id, historyItemParentId);

		if (!historyItemChanges?.length) {
			return;
		}

		const title = historyItems.length === 1 ?
			`${historyItems[0].displayId ?? historyItems[0].id} - ${historyItems[0].message}` :
			localize('historyItemChangesEditorTitle', "All Changes ({0} ↔ {1})", historyItemLast.displayId ?? historyItemLast.id, historyItem.displayId ?? historyItem.id);

		const rootUri = provider.rootUri;
		const path = rootUri ? rootUri.path : provider.label;
		const multiDiffSourceUri = URI.from({ scheme: 'scm-history-item', path: `${path}/${historyItemParentId}..${historyItem.id}` }, true);

		commandService.executeCommand('_workbench.openMultiDiffEditor', { title, multiDiffSourceUri, resources: historyItemChanges });
	}
});

class ListDelegate implements IListVirtualDelegate<TreeElement> {

	getHeight(): number {
		return 22;
	}

	getTemplateId(element: TreeElement): string {
		if (isSCMHistoryItemViewModelTreeElement(element)) {
			return HistoryItemRenderer.TEMPLATE_ID;
		} else if (isSCMHistoryItemLoadMoreTreeElement(element)) {
			return HistoryItemLoadMoreRenderer.TEMPLATE_ID;
		} else {
			throw new Error('Unknown element');
		}
	}
}

interface HistoryItemTemplate {
	readonly element: HTMLElement;
	readonly label: IconLabel;
	readonly graphContainer: HTMLElement;
	readonly labelContainer: HTMLElement;
	readonly elementDisposables: DisposableStore;
	readonly disposables: IDisposable;
}

class HistoryItemRenderer implements ITreeRenderer<SCMHistoryItemViewModelTreeElement, LabelFuzzyScore, HistoryItemTemplate> {

	static readonly TEMPLATE_ID = 'history-item';
	get templateId(): string { return HistoryItemRenderer.TEMPLATE_ID; }

	private readonly _badgesConfig = observableConfigValue<'all' | 'filter'>('scm.graph.badges', 'filter', this._configurationService);

	constructor(
		private readonly hoverDelegate: IHoverDelegate,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IThemeService private readonly _themeService: IThemeService
	) { }

	renderTemplate(container: HTMLElement): HistoryItemTemplate {
		// hack
		(container.parentElement!.parentElement!.querySelector('.monaco-tl-twistie')! as HTMLElement).classList.add('force-no-twistie');

		const element = append(container, $('.history-item'));
		const graphContainer = append(element, $('.graph-container'));
		const iconLabel = new IconLabel(element, { supportIcons: true, supportHighlights: true, supportDescriptionHighlights: true });

		const labelContainer = append(element, $('.label-container'));
		element.appendChild(labelContainer);

		return { element, graphContainer, label: iconLabel, labelContainer, elementDisposables: new DisposableStore(), disposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<SCMHistoryItemViewModelTreeElement, LabelFuzzyScore>, index: number, templateData: HistoryItemTemplate, height: number | undefined): void {
		const historyItemViewModel = node.element.historyItemViewModel;
		const historyItem = historyItemViewModel.historyItem;

		const historyItemHover = this._hoverService.setupManagedHover(this.hoverDelegate, templateData.element, this.getTooltip(node.element));
		templateData.elementDisposables.add(historyItemHover);

		templateData.graphContainer.textContent = '';
		templateData.graphContainer.appendChild(renderSCMHistoryItemGraph(historyItemViewModel));

		const provider = node.element.repository.provider;
		const currentHistoryItemGroup = provider.historyProvider.get()?.currentHistoryItemGroup?.get();
		const extraClasses = currentHistoryItemGroup?.revision === historyItem.id ? ['history-item-current'] : [];
		const [matches, descriptionMatches] = this.processMatches(historyItemViewModel, node.filterData);
		templateData.label.setLabel(historyItem.subject, historyItem.author, { matches, descriptionMatches, extraClasses });

		this._renderLabels(historyItem, templateData);
	}

	private _renderLabels(historyItem: ISCMHistoryItem, templateData: HistoryItemTemplate): void {
		templateData.elementDisposables.add(autorun(reader => {
			const labelConfig = this._badgesConfig.read(reader);

			templateData.labelContainer.textContent = '';
			const firstColoredLabel = historyItem.labels?.find(label => label.color);

			for (const label of historyItem.labels ?? []) {
				if (!label.color && labelConfig === 'filter') {
					continue;
				}

				if (label.icon && ThemeIcon.isThemeIcon(label.icon)) {
					const elements = h('div.label', {
						style: {
							color: label.color ? asCssVariable(historyItemHoverLabelForeground) : asCssVariable(foreground),
							backgroundColor: label.color ? asCssVariable(label.color) : asCssVariable(historyItemHoverDefaultLabelBackground)
						}
					}, [
						h('div.icon@icon'),
						h('div.description@description')
					]);

					elements.icon.classList.add(...ThemeIcon.asClassNameArray(label.icon));

					elements.description.textContent = label.title;
					elements.description.style.display = label === firstColoredLabel ? '' : 'none';

					append(templateData.labelContainer, elements.root);
				}
			}
		}));
	}

	private getTooltip(element: SCMHistoryItemViewModelTreeElement): IManagedHoverTooltipMarkdownString {
		const colorTheme = this._themeService.getColorTheme();
		const historyItem = element.historyItemViewModel.historyItem;

		const markdown = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		markdown.appendMarkdown(`$(git-commit) \`${historyItem.displayId ?? historyItem.id}\`\n\n`);

		if (historyItem.author) {
			markdown.appendMarkdown(`$(account) **${historyItem.author}**`);

			if (historyItem.timestamp) {
				const dateFormatter = new Intl.DateTimeFormat(platform.language, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric' });
				markdown.appendMarkdown(`, $(history) ${fromNow(historyItem.timestamp, true, true)} (${dateFormatter.format(historyItem.timestamp)})`);
			}

			markdown.appendMarkdown('\n\n');
		}

		markdown.appendMarkdown(`${historyItem.message}\n\n`);

		if (historyItem.statistics) {
			markdown.appendMarkdown(`---\n\n`);

			markdown.appendMarkdown(`<span>${historyItem.statistics.files === 1 ?
				localize('fileChanged', "{0} file changed", historyItem.statistics.files) :
				localize('filesChanged', "{0} files changed", historyItem.statistics.files)}</span>`);

			if (historyItem.statistics.insertions) {
				const additionsForegroundColor = colorTheme.getColor(historyItemHoverAdditionsForeground);
				markdown.appendMarkdown(`,&nbsp;<span style="color:${additionsForegroundColor};">${historyItem.statistics.insertions === 1 ?
					localize('insertion', "{0} insertion{1}", historyItem.statistics.insertions, '(+)') :
					localize('insertions', "{0} insertions{1}", historyItem.statistics.insertions, '(+)')}</span>`);
			}

			if (historyItem.statistics.deletions) {
				const deletionsForegroundColor = colorTheme.getColor(historyItemHoverDeletionsForeground);
				markdown.appendMarkdown(`,&nbsp;<span style="color:${deletionsForegroundColor};">${historyItem.statistics.deletions === 1 ?
					localize('deletion', "{0} deletion{1}", historyItem.statistics.deletions, '(-)') :
					localize('deletions', "{0} deletions{1}", historyItem.statistics.deletions, '(-)')}</span>`);
			}
		}

		if ((historyItem.labels ?? []).length > 0) {
			markdown.appendMarkdown(`\n\n---\n\n`);
			markdown.appendMarkdown((historyItem.labels ?? []).map(label => {
				const labelIconId = ThemeIcon.isThemeIcon(label.icon) ? label.icon.id : '';

				const labelBackgroundColor = label.color ? asCssVariable(label.color) : asCssVariable(historyItemHoverDefaultLabelBackground);
				const labelForegroundColor = label.color ? asCssVariable(historyItemHoverLabelForeground) : asCssVariable(historyItemHoverDefaultLabelForeground);

				return `<span style="color:${labelForegroundColor};background-color:${labelBackgroundColor};border-radius:2px;">&nbsp;$(${labelIconId})&nbsp;${label.title}&nbsp;</span>`;
			}).join('&nbsp;&nbsp;'));
		}

		return { markdown, markdownNotSupportedFallback: historyItem.message };
	}

	private processMatches(historyItemViewModel: ISCMHistoryItemViewModel, filterData: LabelFuzzyScore | undefined): [IMatch[] | undefined, IMatch[] | undefined] {
		if (!filterData) {
			return [undefined, undefined];
		}

		return [
			historyItemViewModel.historyItem.message === filterData.label ? createMatches(filterData.score) : undefined,
			historyItemViewModel.historyItem.author === filterData.label ? createMatches(filterData.score) : undefined
		];
	}

	disposeElement(element: ITreeNode<SCMHistoryItemViewModelTreeElement, LabelFuzzyScore>, index: number, templateData: HistoryItemTemplate, height: number | undefined): void {
		templateData.elementDisposables.clear();
	}

	disposeTemplate(templateData: HistoryItemTemplate): void {
		templateData.disposables.dispose();
	}
}

interface LoadMoreTemplate {
	readonly element: HTMLElement;
	readonly graphPlaceholder: HTMLElement;
	readonly historyItemPlaceholderContainer: HTMLElement;
	readonly historyItemPlaceholderLabel: IconLabel;
	readonly elementDisposables: DisposableStore;
	readonly disposables: IDisposable;
}

class HistoryItemLoadMoreRenderer implements ITreeRenderer<SCMHistoryItemLoadMoreTreeElement, void, LoadMoreTemplate> {

	static readonly TEMPLATE_ID = 'historyItemLoadMore';
	get templateId(): string { return HistoryItemLoadMoreRenderer.TEMPLATE_ID; }

	constructor(
		private readonly _loadingMore: () => IObservable<boolean>,
		private readonly _loadMoreCallback: (repository: ISCMRepository) => void,
		@IConfigurationService private readonly _configurationService: IConfigurationService
	) { }

	renderTemplate(container: HTMLElement): LoadMoreTemplate {
		// hack
		(container.parentElement!.parentElement!.querySelector('.monaco-tl-twistie')! as HTMLElement).classList.add('force-no-twistie');

		const element = append(container, $('.history-item-load-more'));
		const graphPlaceholder = append(element, $('.graph-placeholder'));
		const historyItemPlaceholderContainer = append(element, $('.history-item-placeholder'));
		const historyItemPlaceholderLabel = new IconLabel(historyItemPlaceholderContainer, { supportIcons: true });

		return { element, graphPlaceholder, historyItemPlaceholderContainer, historyItemPlaceholderLabel, elementDisposables: new DisposableStore(), disposables: new DisposableStore() };
	}

	renderElement(element: ITreeNode<SCMHistoryItemLoadMoreTreeElement, void>, index: number, templateData: LoadMoreTemplate, height: number | undefined): void {
		templateData.graphPlaceholder.textContent = '';
		templateData.graphPlaceholder.style.width = `${SWIMLANE_WIDTH * (element.element.graphColumns.length + 1)}px`;
		templateData.graphPlaceholder.appendChild(renderSCMHistoryGraphPlaceholder(element.element.graphColumns));

		const pageOnScroll = this._configurationService.getValue<boolean>('scm.graph.pageOnScroll') === true;
		templateData.historyItemPlaceholderContainer.classList.toggle('shimmer', pageOnScroll);

		if (pageOnScroll) {
			templateData.historyItemPlaceholderLabel.setLabel('');
			this._loadMoreCallback(element.element.repository);
		} else {
			templateData.elementDisposables.add(autorun(reader => {
				const loadingMore = this._loadingMore().read(reader);
				const icon = `$(${loadingMore ? 'loading~spin' : 'fold-down'})`;

				templateData.historyItemPlaceholderLabel.setLabel(localize('loadMore', "{0} Load More...", icon));
			}));
		}
	}

	disposeElement(element: ITreeNode<SCMHistoryItemLoadMoreTreeElement, void>, index: number, templateData: LoadMoreTemplate, height: number | undefined): void {
		templateData.elementDisposables.clear();
	}

	disposeTemplate(templateData: LoadMoreTemplate): void {
		templateData.disposables.dispose();
	}
}

class HistoryItemHoverDelegate extends WorkbenchHoverDelegate {
	constructor(
		private readonly _viewContainerLocation: ViewContainerLocation | null,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService configurationService: IConfigurationService,
		@IHoverService hoverService: IHoverService,

	) {
		super('element', true, () => this.getHoverOptions(), configurationService, hoverService);
	}

	private getHoverOptions(): Partial<IHoverOptions> {
		const sideBarPosition = this.layoutService.getSideBarPosition();

		let hoverPosition: HoverPosition;
		if (this._viewContainerLocation === ViewContainerLocation.Sidebar) {
			hoverPosition = sideBarPosition === Position.LEFT ? HoverPosition.RIGHT : HoverPosition.LEFT;
		} else if (this._viewContainerLocation === ViewContainerLocation.AuxiliaryBar) {
			hoverPosition = sideBarPosition === Position.LEFT ? HoverPosition.LEFT : HoverPosition.RIGHT;
		} else {
			hoverPosition = HoverPosition.RIGHT;
		}

		return { additionalClasses: ['history-item-hover'], position: { hoverPosition, forcePosition: true } };
	}
}

class SCMHistoryViewPaneActionRunner extends ActionRunner {
	constructor(@IProgressService private readonly _progressService: IProgressService) {
		super();
	}

	protected override runAction(action: IAction, context?: unknown): Promise<void> {
		return this._progressService.withProgress({ location: HISTORY_VIEW_PANE_ID },
			async () => await super.runAction(action, context));
	}
}

class SCMHistoryTreeAccessibilityProvider implements IListAccessibilityProvider<TreeElement> {

	getWidgetAriaLabel(): string {
		return localize('scm history', "Source Control History");
	}

	getAriaLabel(element: TreeElement): string {
		if (isSCMRepository(element)) {
			return `${element.provider.name} ${element.provider.label}`;
		} else if (isSCMHistoryItemViewModelTreeElement(element)) {
			const historyItem = element.historyItemViewModel.historyItem;
			return `${stripIcons(historyItem.message).trim()}${historyItem.author ? `, ${historyItem.author}` : ''}`;
		} else {
			return '';
		}
	}
}

class SCMHistoryTreeIdentityProvider implements IIdentityProvider<TreeElement> {

	getId(element: TreeElement): string {
		if (isSCMRepository(element)) {
			const provider = element.provider;
			return `repo:${provider.id}`;
		} else if (isSCMHistoryItemViewModelTreeElement(element)) {
			const provider = element.repository.provider;
			const historyItem = element.historyItemViewModel.historyItem;
			return `historyItem:${provider.id}/${historyItem.id}/${historyItem.parentIds.join(',')}`;
		} else if (isSCMHistoryItemLoadMoreTreeElement(element)) {
			const provider = element.repository.provider;
			return `historyItemLoadMore:${provider.id}}`;
		} else {
			throw new Error('Invalid tree element');
		}
	}
}

class SCMHistoryTreeKeyboardNavigationLabelProvider implements IKeyboardNavigationLabelProvider<TreeElement> {
	getKeyboardNavigationLabel(element: TreeElement): { toString(): string } | { toString(): string }[] | undefined {
		if (isSCMRepository(element)) {
			return undefined;
		} else if (isSCMHistoryItemViewModelTreeElement(element)) {
			// For a history item we want to match both the message and
			// the author. A match in the message takes precedence over
			// a match in the author.
			return [element.historyItemViewModel.historyItem.message, element.historyItemViewModel.historyItem.author];
		} else if (isSCMHistoryItemLoadMoreTreeElement(element)) {
			// We don't want to match the load more element
			return '';
		} else {
			throw new Error('Invalid tree element');
		}
	}
}

type HistoryItemState = { currentHistoryItemGroup: ISCMHistoryItemGroup; items: ISCMHistoryItem[]; loadMore: boolean };

class SCMHistoryTreeDataSource extends Disposable implements IAsyncDataSource<SCMHistoryViewModel, TreeElement> {

	async getChildren(inputOrElement: SCMHistoryViewModel | TreeElement): Promise<Iterable<TreeElement>> {
		if (!(inputOrElement instanceof SCMHistoryViewModel)) {
			return [];
		}

		// History items
		const children: TreeElement[] = [];
		const historyItems = await inputOrElement.getHistoryItems();
		children.push(...historyItems);

		// Load More element
		const repository = inputOrElement.repository.get();
		const lastHistoryItem = tail(historyItems);
		if (repository && lastHistoryItem && lastHistoryItem.historyItemViewModel.outputSwimlanes.length > 0) {
			children.push({
				repository,
				graphColumns: lastHistoryItem.historyItemViewModel.outputSwimlanes,
				type: 'historyItemLoadMore'
			} satisfies SCMHistoryItemLoadMoreTreeElement);
		}

		return children;
	}

	hasChildren(inputOrElement: SCMHistoryViewModel | TreeElement): boolean {
		return inputOrElement instanceof SCMHistoryViewModel;
	}
}

class SCMHistoryViewModel extends Disposable {

	private readonly _closedRepository = observableFromEvent(
		this,
		this._scmService.onDidRemoveRepository,
		repository => repository);

	private readonly _firstRepository = this._scmService.repositoryCount > 0 ?
		constObservable(Iterable.first(this._scmService.repositories)) :
		observableFromEvent(
			this,
			Event.once(this._scmService.onDidAddRepository),
			repository => repository
		);

	private readonly _selectedRepository = observableValue<'auto' | ISCMRepository>(this, 'auto');

	private readonly _graphRepository = derived(reader => {
		const selectedRepository = this._selectedRepository.read(reader);
		if (selectedRepository !== 'auto') {
			return selectedRepository;
		}

		return this._scmViewService.activeRepository.read(reader);
	});

	/**
	 * The active | selected repository takes precedence over the first repository when the observable
	 * values are updated in the same transaction (or during the initial read of the observable value).
	 */
	readonly repository = latestChangedValue(this, [this._firstRepository, this._graphRepository]);

	private readonly _historyItemGroupFilter = observableValue<'all' | 'auto' | string[]>(this, 'auto');

	readonly historyItemGroupFilter = derived<string[]>(reader => {
		const filter = this._historyItemGroupFilter.read(reader);
		if (Array.isArray(filter)) {
			return filter;
		}

		if (filter === 'all') {
			return [];
		}

		const repository = this.repository.get();
		const historyProvider = repository?.provider.historyProvider.get();
		const currentHistoryItemGroup = historyProvider?.currentHistoryItemGroup.get();

		if (!currentHistoryItemGroup) {
			return [];
		}

		return [
			currentHistoryItemGroup.revision ?? currentHistoryItemGroup.id,
			...currentHistoryItemGroup.remote ? [currentHistoryItemGroup.remote.revision ?? currentHistoryItemGroup.remote.id] : [],
			...currentHistoryItemGroup.base ? [currentHistoryItemGroup.base.revision ?? currentHistoryItemGroup.base.id] : [],
		];
	});

	private readonly _state = new Map<ISCMRepository, HistoryItemState>();

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISCMService private readonly _scmService: ISCMService,
		@ISCMViewService private readonly _scmViewService: ISCMViewService
	) {
		super();

		// Closed repository cleanup
		this._register(autorun(reader => {
			const repository = this._closedRepository.read(reader);
			if (!repository) {
				return;
			}

			if (this.repository.get() === repository) {
				this._selectedRepository.set(Iterable.first(this._scmService.repositories) ?? 'auto', undefined);
			}

			this._state.delete(repository);
		}));
	}

	clearRepositoryState(): void {
		const repository = this.repository.get();
		if (!repository) {
			return;
		}

		this._state.delete(repository);
	}

	setLoadMore(repository: ISCMRepository, loadMore: boolean): void {
		const state = this._state.get(repository);
		if (!state) {
			return;
		}

		this._state.set(repository, { ...state, loadMore });
	}

	async getHistoryItems(): Promise<SCMHistoryItemViewModelTreeElement[]> {
		const repository = this.repository.get();
		if (!repository) {
			return [];
		}

		let state = this._state.get(repository);
		const historyProvider = repository.provider.historyProvider.get();
		const currentHistoryItemGroup = state?.currentHistoryItemGroup ?? historyProvider?.currentHistoryItemGroup.get();

		if (!historyProvider || !currentHistoryItemGroup) {
			return [];
		}

		if (!state || state.loadMore) {
			const existingHistoryItems = state?.items ?? [];

			const historyItemGroupIds = this.historyItemGroupFilter.get();
			const limit = clamp(this._configurationService.getValue<number>('scm.graph.pageSize'), 1, 1000);

			const historyItems = await historyProvider.provideHistoryItems({
				historyItemGroupIds, limit, skip: existingHistoryItems.length
			}) ?? [];

			state = {
				currentHistoryItemGroup,
				items: [...existingHistoryItems, ...historyItems],
				loadMore: false
			};

			this._state.set(repository, state);
		}

		// Create the color map
		const colorMap = this._getGraphColorMap(currentHistoryItemGroup);

		return toISCMHistoryItemViewModelArray(state.items, colorMap)
			.map(historyItemViewModel => ({
				repository,
				historyItemViewModel,
				type: 'historyItemViewModel'
			}) satisfies SCMHistoryItemViewModelTreeElement);
	}

	setRepository(repository: ISCMRepository | 'auto'): void {
		this._selectedRepository.set(repository, undefined);
	}

	private _getGraphColorMap(currentHistoryItemGroup: ISCMHistoryItemGroup): Map<string, ColorIdentifier> {
		const colorMap = new Map<string, ColorIdentifier>([
			[currentHistoryItemGroup.name, historyItemGroupLocal]
		]);
		if (currentHistoryItemGroup.remote) {
			colorMap.set(currentHistoryItemGroup.remote.name, historyItemGroupRemote);
		}
		if (currentHistoryItemGroup.base) {
			colorMap.set(currentHistoryItemGroup.base.name, historyItemGroupBase);
		}
		if (this._historyItemGroupFilter.get() === 'all') {
			colorMap.set('*', '');
		}

		return colorMap;
	}

	override dispose(): void {
		this._state.clear();
		super.dispose();
	}
}

export class SCMHistoryViewPane extends ViewPane {

	private _treeContainer!: HTMLElement;
	private _tree!: WorkbenchAsyncDataTree<SCMHistoryViewModel, TreeElement, FuzzyScore>;
	private _treeViewModel!: SCMHistoryViewModel;
	private _treeDataSource!: SCMHistoryTreeDataSource;
	private _treeIdentityProvider!: SCMHistoryTreeIdentityProvider;
	private _repositoryLoadMore = observableValue(this, false);

	private readonly _actionRunner: IActionRunner;
	private readonly _visibilityDisposables = new DisposableStore();

	private readonly _treeOperationSequencer = new Sequencer();
	private readonly _treeLoadMoreSequencer = new Sequencer();
	private readonly _updateChildrenThrottler = new Throttler();

	private readonly _scmProviderCtx: IContextKey<string | undefined>;

	constructor(
		options: IViewPaneOptions,
		@ICommandService private readonly _commandService: ICommandService,
		@ISCMViewService private readonly _scmViewService: ISCMViewService,
		@IProgressService private readonly _progressService: IProgressService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService
	) {
		super({
			...options,
			titleMenuId: MenuId.SCMHistoryTitle,
			showActions: ViewPaneShowActions.WhenExpanded
		}, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);

		this._scmProviderCtx = ContextKeys.SCMProvider.bindTo(this.scopedContextKeyService);

		this._actionRunner = this.instantiationService.createInstance(SCMHistoryViewPaneActionRunner);
		this._register(this._actionRunner);

		this._register(this._updateChildrenThrottler);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._tree.layout(height, width);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._treeContainer = append(container, $('.scm-view.scm-history-view'));
		this._treeContainer.classList.add('file-icon-themable-tree');

		this._createTree(this._treeContainer);

		this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this._treeViewModel = this.instantiationService.createInstance(SCMHistoryViewModel);
				this._visibilityDisposables.add(this._treeViewModel);

				const firstRepository = derivedConstOnceDefined(this, reader => {
					const repository = this._treeViewModel.repository.read(reader);
					const historyProvider = repository?.provider.historyProvider.read(reader);
					const currentHistoryItemGroup = historyProvider?.currentHistoryItemGroup.read(reader);

					return currentHistoryItemGroup !== undefined ? repository : undefined;
				});

				this._visibilityDisposables.add(autorunWithStore(async (reader, store) => {
					const repository = firstRepository.read(reader);
					if (!repository) {
						return;
					}

					this._treeOperationSequencer.queue(async () => {
						await this._tree.setInput(this._treeViewModel);
						this._tree.scrollTop = 0;
					});

					// Repository change
					store.add(
						autorunWithStoreHandleChanges<{ refresh: boolean }>({
							owner: this,
							createEmptyChangeSummary: () => ({ refresh: false }),
							handleChange(_, changeSummary) {
								changeSummary.refresh = true;
								return true;
							},
						}, (reader, changeSummary, store) => {
							const repository = this._treeViewModel.repository.read(reader);
							const historyProvider = repository?.provider.historyProvider.read(reader);
							if (!repository || !historyProvider) {
								return;
							}

							// Update context
							this._scmProviderCtx.set(repository.provider.contextValue);

							// Checkout, Commit, and Publish
							const historyItemGroup = derivedOpts<{ id: string; revision?: string; remoteId?: string } | undefined>({
								owner: this,
								equalsFn: structuralEquals
							}, reader => {
								const currentHistoryItemGroup = historyProvider.currentHistoryItemGroup.read(reader);
								return currentHistoryItemGroup ? {
									id: currentHistoryItemGroup.id,
									revision: currentHistoryItemGroup.revision,
									remoteId: currentHistoryItemGroup.remote?.id
								} : undefined;
							});

							// Fetch, Push
							const historyItemRemoteRevision = derived(reader => {
								return historyProvider.currentHistoryItemGroup.read(reader)?.remote?.revision;
							});

							// HistoryItemGroup change
							store.add(
								autorunWithStoreHandleChanges<{ refresh: boolean | 'ifScrollTop' }>({
									owner: this,
									createEmptyChangeSummary: () => ({ refresh: false }),
									handleChange(context, changeSummary) {
										changeSummary.refresh = context.didChange(historyItemRemoteRevision) ? 'ifScrollTop' : true;
										return true;
									},
								}, (reader, changeSummary) => {
									if ((!historyItemGroup.read(reader) && !historyItemRemoteRevision.read(reader)) || changeSummary.refresh === false) {
										return;
									}

									if (changeSummary.refresh === true) {
										this.refresh();
										return;
									}

									if (changeSummary.refresh === 'ifScrollTop') {
										// Remote revision changes can occur as a result of a user action (Fetch, Push) but
										// it can also occur as a result of background action (Auto Fetch). If the tree is
										// scrolled to the top, we can safely refresh the tree.
										if (this._tree.scrollTop === 0) {
											this.refresh();
											return;
										}

										// Set the "OUTDATED" description
										this.updateTitleDescription(localize('outdated', "OUTDATED"));
									}
								}));

							if (changeSummary.refresh) {
								this.refresh();
							}
						}));
				}));
			} else {
				this._visibilityDisposables.clear();
			}
		});
	}

	override getActionRunner(): IActionRunner | undefined {
		return this._actionRunner;
	}

	override getActionsContext(): ISCMProvider | undefined {
		return this._treeViewModel?.repository.get()?.provider;
	}

	override getActionViewItem(action: IAction, options?: IDropdownMenuActionViewItemOptions): IActionViewItem | undefined {
		if (action.id === 'workbench.scm.action.repository') {
			const repository = this._treeViewModel?.repository.get();
			if (repository) {
				return new SCMRepositoryActionViewItem(repository, action, options);
			}
		}

		return super.getActionViewItem(action, options);
	}

	async refresh(): Promise<void> {
		await this._updateChildren(true);

		this.updateActions();
		this.updateTitleDescription(undefined);
		this._tree.scrollTop = 0;
	}

	async pickRepository(): Promise<void> {
		const picks: (IQuickPickItem & { repository: 'auto' | ISCMRepository } | IQuickPickSeparator)[] = [
			{
				label: localize('auto', "Auto"),
				description: localize('activeRepository', "Show the source control graph for the active repository"),
				repository: 'auto'
			},
			{
				type: 'separator'
			},
		];

		picks.push(...this._scmViewService.repositories.map(r => ({
			label: r.provider.name,
			description: r.provider.rootUri?.fsPath,
			iconClass: ThemeIcon.asClassName(Codicon.repo),
			repository: r
		})));

		const result = await this._quickInputService.pick(picks, {
			placeHolder: localize('scmGraphRepository', "Select the repository to view, type to filter all repositories")
		});

		if (result) {
			this._treeViewModel.setRepository(result.repository);
		}
	}

	private _createTree(container: HTMLElement): void {
		this._treeIdentityProvider = new SCMHistoryTreeIdentityProvider();

		const historyItemHoverDelegate = this.instantiationService.createInstance(HistoryItemHoverDelegate, this.viewDescriptorService.getViewLocationById(this.id));
		this._register(historyItemHoverDelegate);

		this._treeDataSource = this.instantiationService.createInstance(SCMHistoryTreeDataSource);
		this._register(this._treeDataSource);

		this._tree = this.instantiationService.createInstance(
			WorkbenchAsyncDataTree,
			'SCM History Tree',
			container,
			new ListDelegate(),
			[
				this.instantiationService.createInstance(HistoryItemRenderer, historyItemHoverDelegate),
				this.instantiationService.createInstance(
					HistoryItemLoadMoreRenderer,
					() => this._repositoryLoadMore,
					repository => this._loadMoreCallback(repository)),
			],
			this._treeDataSource,
			{
				accessibilityProvider: new SCMHistoryTreeAccessibilityProvider(),
				identityProvider: this._treeIdentityProvider,
				collapseByDefault: (e: unknown) => false,
				keyboardNavigationLabelProvider: new SCMHistoryTreeKeyboardNavigationLabelProvider(),
				horizontalScrolling: false,
				multipleSelectionSupport: false,
			}
		) as WorkbenchAsyncDataTree<SCMHistoryViewModel, TreeElement, FuzzyScore>;
		this._register(this._tree);

		this._tree.onDidOpen(this._onDidOpen, this, this._store);
		this._tree.onContextMenu(this._onContextMenu, this, this._store);
	}

	private async _onDidOpen(e: IOpenEvent<TreeElement | undefined>): Promise<void> {
		if (!e.element) {
			return;
		} else if (isSCMHistoryItemViewModelTreeElement(e.element)) {
			const historyItem = e.element.historyItemViewModel.historyItem;
			const historyItemParentId = historyItem.parentIds.length > 0 ? historyItem.parentIds[0] : undefined;

			const historyProvider = e.element.repository.provider.historyProvider.get();
			const historyItemChanges = await historyProvider?.provideHistoryItemChanges(historyItem.id, historyItemParentId);
			if (historyItemChanges) {
				const title = `${historyItem.displayId ?? historyItem.id} - ${historyItem.message}`;

				const rootUri = e.element.repository.provider.rootUri;
				const path = rootUri ? rootUri.path : e.element.repository.provider.label;
				const multiDiffSourceUri = URI.from({ scheme: 'scm-history-item', path: `${path}/${historyItemParentId}..${historyItem.id}` }, true);

				await this._commandService.executeCommand('_workbench.openMultiDiffEditor', { title, multiDiffSourceUri, resources: historyItemChanges });
			}
		} else if (isSCMHistoryItemLoadMoreTreeElement(e.element)) {
			const pageOnScroll = this.configurationService.getValue<boolean>('scm.graph.pageOnScroll') === true;
			if (!pageOnScroll) {
				this._loadMoreCallback(e.element.repository);
				this._tree.setSelection([]);
			}
		}
	}

	private _onContextMenu(e: ITreeContextMenuEvent<TreeElement | null>): void {
		const element = e.element;

		if (!element || !isSCMHistoryItemViewModelTreeElement(element)) {
			return;
		}

		this.contextMenuService.showContextMenu({
			menuId: MenuId.SCMChangesContext,
			menuActionOptions: {
				arg: element.repository.provider,
				shouldForwardArgs: true
			},
			getAnchor: () => e.anchor,
			getActionsContext: () => element.historyItemViewModel.historyItem
		});
	}

	private async _loadMoreCallback(repository: ISCMRepository): Promise<void> {
		return this._treeLoadMoreSequencer.queue(async () => {
			if (this._repositoryLoadMore.get()) {
				return;
			}

			this._repositoryLoadMore.set(true, undefined);
			this._treeViewModel.setLoadMore(repository, true);

			await this._updateChildren();
			this._repositoryLoadMore.set(false, undefined);
		});
	}

	private _updateChildren(clearCache = false): Promise<void> {
		return this._updateChildrenThrottler.queue(
			() => this._treeOperationSequencer.queue(
				async () => {
					if (clearCache) {
						this._treeViewModel.clearRepositoryState();
					}

					await this._progressService.withProgress({ location: this.id },
						async () => {
							await this._tree.updateChildren(undefined, undefined, undefined, {
								// diffIdentityProvider: this._treeIdentityProvider
							});
						});
				}));
	}

	override dispose(): void {
		this._visibilityDisposables.dispose();
		super.dispose();
	}
}
