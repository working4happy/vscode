/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IObservable, ITransaction } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { TextEdit } from '../../../../editor/common/languages.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IChatEditingService = createDecorator<IChatEditingService>('chatEditingService');

export interface IChatEditingService {
	_serviceBrand: undefined;

	readonly onDidCreateEditingSession: Event<IChatEditingSession>;
	readonly onDidDisposeEditingSession: Event<IChatEditingSession>;

	readonly currentEditingSession: IChatEditingSession | null;

	startOrContinueEditingSession(chatSessionId: string, builder: (stream: IChatEditingSessionStream) => Promise<void>): Promise<void>;
}

export interface IChatEditingSession {
	readonly chatSessionId: string;
	readonly onDidEditNewResource: Event<URI>;
	readonly state: IObservable<ChatEditingSessionState>;
	readonly entries: IObservable<readonly IModifiedFileEntry[]>;

}

export interface IModifiedFileEntry {
	readonly originalURI: URI;
	readonly modifiedURI: URI;
	accept(transaction: ITransaction | undefined): Promise<void>;
	reject(transaction: ITransaction | undefined): Promise<void>;
}

export interface IChatEditingSessionStream {
	textEdits(resource: URI, textEdits: TextEdit[]): void;
}

export const enum ChatEditingSessionState {
	Initial = 0,
	StreamingEdits = 1,
	Idle = 2
}
