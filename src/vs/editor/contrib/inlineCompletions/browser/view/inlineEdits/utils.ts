/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { h } from '../../../../../../base/browser/dom.js';
import { KeybindingLabel, unthemedKeybindingLabelOptions } from '../../../../../../base/browser/ui/keybindingLabel/keybindingLabel.js';
import { numberComparator } from '../../../../../../base/common/arrays.js';
import { findFirstMin } from '../../../../../../base/common/arraysFind.js';
import { IReader } from '../../../../../../base/common/observable.js';
import { OS } from '../../../../../../base/common/platform.js';
import { splitLines, getIndentationLength } from '../../../../../../base/common/strings.js';
import { URI } from '../../../../../../base/common/uri.js';
import { MenuEntryActionViewItem } from '../../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { ObservableCodeEditor } from '../../../../../browser/observableCodeEditor.js';
import { LineRange } from '../../../../../common/core/lineRange.js';
import { OffsetRange } from '../../../../../common/core/offsetRange.js';
import { SingleTextEdit, TextEdit } from '../../../../../common/core/textEdit.js';
import { RangeMapping } from '../../../../../common/diff/rangeMapping.js';
import { Range } from '../../../../../common/core/range.js';
import { Position } from '../../../../../common/core/position.js';

export function maxLeftInRange(editor: ObservableCodeEditor, range: LineRange, reader: IReader): number {
	editor.layoutInfo.read(reader);
	editor.value.read(reader);

	const model = editor.model.read(reader);
	if (!model) { return 0; }
	let maxLeft = 0;

	editor.scrollTop.read(reader);
	for (let i = range.startLineNumber; i < range.endLineNumberExclusive; i++) {
		const column = model.getLineMaxColumn(i);
		const left = editor.editor.getOffsetForColumn(i, column);
		maxLeft = Math.max(maxLeft, left);
	}
	const lines = range.mapToLineArray(l => model.getLineContent(l));

	if (maxLeft < 5 && lines.some(l => l.length > 0) && model.uri.scheme !== 'file') {
		console.error('unexpected width');
	}
	return maxLeft;
}

export class StatusBarViewItem extends MenuEntryActionViewItem {
	protected override updateLabel() {
		const kb = this._keybindingService.lookupKeybinding(this._action.id, this._contextKeyService);
		if (!kb) {
			return super.updateLabel();
		}
		if (this.label) {
			const div = h('div.keybinding').root;
			const keybindingLabel = this._register(new KeybindingLabel(div, OS, { disableTitle: true, ...unthemedKeybindingLabelOptions }));
			keybindingLabel.set(kb);
			this.label.textContent = this._action.label;
			this.label.appendChild(div);
			this.label.classList.add('inlineSuggestionStatusBarItemLabel');
		}
	}

	protected override updateTooltip(): void {
		// NOOP, disable tooltip
	}
}

export class Point {
	constructor(
		public readonly x: number,
		public readonly y: number,
	) { }

	public add(other: Point): Point {
		return new Point(this.x + other.x, this.y + other.y);
	}

	public deltaX(delta: number): Point {
		return new Point(this.x + delta, this.y);
	}
}

export class UniqueUriGenerator {
	private static _modelId = 0;

	constructor(
		public readonly scheme: string
	) { }

	public getUniqueUri(): URI {
		return URI.from({ scheme: this.scheme, path: new Date().toString() + String(UniqueUriGenerator._modelId++) });
	}
}
export function applyEditToModifiedRangeMappings(rangeMapping: RangeMapping[], edit: TextEdit): RangeMapping[] {
	const updatedMappings: RangeMapping[] = [];
	for (const m of rangeMapping) {
		const updatedRange = edit.mapRange(m.modifiedRange);
		updatedMappings.push(new RangeMapping(m.originalRange, updatedRange));
	}
	return updatedMappings;
}


export function classNames(...classes: (string | false | undefined | null)[]) {
	return classes.filter(c => typeof c === 'string').join(' ');
}

function offsetRangeToRange(columnOffsetRange: OffsetRange, startPos: Position): Range {
	return new Range(
		startPos.lineNumber,
		startPos.column + columnOffsetRange.start,
		startPos.lineNumber,
		startPos.column + columnOffsetRange.endExclusive,
	);
}

export function createReindentEdit(text: string, range: LineRange): TextEdit {
	const newLines = splitLines(text);
	const edits: SingleTextEdit[] = [];
	const minIndent = findFirstMin(range.mapToLineArray(l => getIndentationLength(newLines[l - 1])), numberComparator)!;
	range.forEach(lineNumber => {
		edits.push(new SingleTextEdit(offsetRangeToRange(new OffsetRange(0, minIndent), new Position(lineNumber, 1)), ''));
	});
	return new TextEdit(edits);
}

export class PathBuilder {
	private _data: string = '';

	public moveTo(point: Point): this {
		this._data += `M ${point.x} ${point.y} `;
		return this;
	}

	public lineTo(point: Point): this {
		this._data += `L ${point.x} ${point.y} `;
		return this;
	}

	public curveTo(cp: Point, to: Point): this {
		this._data += `Q ${cp.x} ${cp.y} ${to.x} ${to.y} `;
		return this;
	}

	public curveTo2(cp1: Point, cp2: Point, to: Point): this {
		this._data += `C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${to.x} ${to.y} `;
		return this;
	}

	public build(): string {
		return this._data;
	}
}
