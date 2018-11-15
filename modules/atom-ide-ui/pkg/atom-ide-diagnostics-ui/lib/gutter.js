/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

import type {
  DiagnosticUpdater,
  DiagnosticMessage,
} from '../../atom-ide-diagnostics/lib/types';
import type {NuclideUri} from 'nuclide-commons/nuclideUri';

import classnames from 'classnames';
import {Range} from 'atom';
import invariant from 'assert';
import {Button} from 'nuclide-commons-ui/Button';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import * as React from 'react';
import ReactDOM from 'react-dom';
import {observableFromSubscribeFunction} from 'nuclide-commons/event';
import {completingSwitchMap} from 'nuclide-commons/observable';
import {goToLocation as atomGoToLocation} from 'nuclide-commons-atom/go-to-location';
import {wordAtPosition} from 'nuclide-commons-atom/range';
import analytics from 'nuclide-commons/analytics';
import {Observable, Subject} from 'rxjs';
import BlockDecoration from 'nuclide-commons-ui/BlockDecoration';
import * as GroupUtils from './GroupUtils';
import {hoveringOrAiming} from './aim';
import {makeDatatipComponent} from './getDiagnosticDatatip.js';
import {decorateTrackTimingSampled} from 'nuclide-commons/analytics';

const APPLY_UPDATE_TO_EDITOR_SAMPLE_RATE = 40;
const DESTROY_DIAGNOSTICS_POPUP_DELAY = 200;
const GUTTER_ID = 'diagnostics-gutter';

// TODO(mbolin): Make it so that when mousing over an element with this CSS class (or specifically,
// the child element with the "region" CSS class), we also do a showPopupFor(). This seems to be
// tricky given how the DOM of a TextEditor works today. There are div.tile elements, each of which
// has its own div.highlights element and many div.line elements. The div.highlights element has 0
// or more children, each child being a div.highlight with a child div.region. The div.region
// element is defined to be {position: absolute; pointer-events: none; z-index: -1}. The absolute
// positioning and negative z-index make it so it isn't eligible for mouseover events, so we
// might have to listen for mouseover events on TextEditor and then use its own APIs, such as
// decorationsForScreenRowRange(), to see if there is a hit target instead. Since this will be
// happening onmousemove, we also have to be careful to make sure this is not expensive.
const HIGHLIGHT_CSS = 'diagnostics-gutter-ui-highlight';

const HIGHLIGHT_CSS_LEVELS = {
  Error: 'diagnostics-gutter-ui-highlight-error',
  Warning: 'diagnostics-gutter-ui-highlight-warning',
  Info: 'diagnostics-gutter-ui-highlight-info',
  Hint: '',
};

const GUTTER_CSS_GROUPS = {
  review: 'diagnostics-gutter-ui-gutter-review',
  errors: 'diagnostics-gutter-ui-gutter-error',
  warnings: 'diagnostics-gutter-ui-gutter-warning',
  info: 'diagnostics-gutter-ui-gutter-info',
  action: 'diagnostics-gutter-ui-gutter-action',
  hidden: '',
};

const editorToMarkers: WeakMap<TextEditor, Set<atom$Marker>> = new WeakMap();
const itemToEditor: WeakMap<HTMLElement, TextEditor> = new WeakMap();
const handleSpawnPopupEvents = new Subject();

const SpawnPopupEvents = handleSpawnPopupEvents
  .switchMap(
    ({
      messages,
      diagnosticUpdater,
      gutter,
      item,
      editorElement,
      gutterMarker,
    }) => {
      return spawnPopup(messages, diagnosticUpdater, gutter, item)
        .let(
          completingSwitchMap((popupElement: HTMLElement) => {
            const innerPopupElement = popupElement.firstChild;
            invariant(innerPopupElement instanceof HTMLElement);
            // Events which should cause the popup to close.
            return Observable.merge(
              hoveringOrAiming(item, innerPopupElement, editorElement),
              // This makes sure that the popup disappears when you ctrl+tab to switch tabs.
              observableFromSubscribeFunction(cb =>
                atom.workspace.onDidChangeActivePaneItem(cb),
              ).mapTo(false),
              observableFromSubscribeFunction(cb =>
                gutterMarker.onDidDestroy(cb),
              )
                .delay(DESTROY_DIAGNOSTICS_POPUP_DELAY)
                .mapTo(false),
              Observable.fromEvent(item, 'click')
                .filter(() =>
                  messages.some(message => message.kind === 'review'),
                )
                .mapTo(false),
            );
          }),
        )
        .takeUntil(
          observableFromSubscribeFunction(cb => gutter.onDidDestroy(cb)),
        )
        .takeWhile(Boolean);
    },
  )
  .share();

_applyUpdateToEditor.displayName = 'applyUpdateToEditor';
export const applyUpdateToEditor = decorateTrackTimingSampled(
  _applyUpdateToEditor,
  APPLY_UPDATE_TO_EDITOR_SAMPLE_RATE,
);

function _applyUpdateToEditor(
  editor: TextEditor,
  update: Iterable<DiagnosticMessage>,
  diagnosticUpdater: DiagnosticUpdater,
  blockDecorationContainer: HTMLElement,
  openedMessageIds: Set<string>,
  setOpenMessageIds: (openedMessageIds: Set<string>) => void,
): void {
  let gutter = editor.gutterWithName(GUTTER_ID);
  if (!gutter) {
    // TODO(jessicalin): Determine an appropriate priority so that the gutter:
    // (1) Shows up to the right of the line numbers.
    // (2) Shows the items that are added to it right away.
    // Using a value of 10 fixes (1), but breaks (2). This seems like it is likely a bug in Atom.

    // By default, a gutter will be destroyed when its editor is destroyed,
    // so there is no need to register a callback via onDidDestroy().
    gutter = editor.addGutter({
      name: GUTTER_ID,
      visible: false,
      // Priority is -200 by default and 0 is the line number
      priority: -1000,
    });
  }

  let marker;
  let markers = editorToMarkers.get(editor);

  // TODO: Consider a more efficient strategy that does not blindly destroy all of the
  // existing markers.
  if (markers) {
    for (marker of markers) {
      marker.destroy();
    }
    markers.clear();
  } else {
    markers = new Set();
  }

  const rowToMessage: Map<number, Array<DiagnosticMessage>> = new Map();
  function addMessageForRow(message: DiagnosticMessage, row: number) {
    let messages = rowToMessage.get(row);
    if (!messages) {
      messages = [];
      rowToMessage.set(row, messages);
    }
    messages.push(message);
  }

  // TODO: Implement chunking and async rendering
  const allMessages = Array.from(update);
  for (const message of allMessages) {
    const wordRange =
      message.range != null && message.range.isEmpty()
        ? wordAtPosition(editor, message.range.start)
        : null;
    const range = wordRange != null ? wordRange.range : message.range;

    const highlightCssClass = classnames(
      HIGHLIGHT_CSS,
      HIGHLIGHT_CSS_LEVELS[message.type],
      message.stale ? 'diagnostics-gutter-ui-highlight-stale' : '',
    );

    let highlightMarker;
    if (range) {
      addMessageForRow(message, range.start.row);

      // There is no API in Atom to say: I want to put an underline on all the
      // lines in this range. The closest is "highlight" which splits your range
      // into three boxes: the part of the first line, all the lines in between
      // and the part of the last line.
      //
      // This means that some lines in the middle are going to be dropped and
      // they are going to extend all the way to the right of the buffer.
      //
      // To fix this, we can manually split it line by line and give to atom
      // those ranges.
      for (let line = range.start.row; line <= range.end.row; line++) {
        let start;
        let end;
        const lineText = editor.getTextInBufferRange(
          new Range([line, 0], [line + 1, 0]),
        );

        if (line === range.start.row) {
          start = range.start.column;
        } else {
          start = (lineText.match(/^\s*/) || [''])[0].length;
        }

        if (line === range.end.row) {
          end = range.end.column;
        } else {
          // Note: this is technically off by 1 (\n) or 2 (\r\n) but Atom will
          // not extend the range past the actual characters displayed on the
          // line
          end = lineText.length;
        }

        highlightMarker = editor.markBufferRange(
          new Range([line, start], [line, end]),
        );
        editor.decorateMarker(highlightMarker, {
          type: 'highlight',
          class: highlightCssClass,
        });
        markers.add(highlightMarker);
      }
    } else {
      addMessageForRow(message, 0);
    }
  }

  // create diagnostics messages with block decoration and maintain their openness
  createBlockDecorations(
    editor,
    rowToMessage,
    blockDecorationContainer,
    openedMessageIds,
    setOpenMessageIds,
  );

  // Find all of the gutter markers for the same row and combine them into one marker/popup.
  for (const [row, messages] of rowToMessage.entries()) {
    // This marker adds some UI to the gutter.
    const gutterMarker = editor.markBufferPosition([row, 0]);
    const {item, dispose} = createGutterItem(
      editor,
      messages,
      diagnosticUpdater,
      gutter,
      openedMessageIds,
      setOpenMessageIds,
      gutterMarker,
    );
    itemToEditor.set(item, editor);
    gutter.decorateMarker(gutterMarker, {item});
    gutterMarker.onDidDestroy(dispose);
    markers.add(gutterMarker);
  }

  editorToMarkers.set(editor, markers);
  editor.onDidDestroy(() => {
    // clean up openned message ids
    removeOpenMessageId(allMessages, openedMessageIds, setOpenMessageIds);
  });
  // Once the gutter is shown for the first time, it is displayed for the lifetime of the
  // TextEditor.
  if (allMessages.length > 0) {
    gutter.show();
    analytics.track('diagnostics-show-editor-diagnostics');
  }
}

function createBlockDecorations(
  editor: TextEditor,
  rowToMessage: Map<number, Array<DiagnosticMessage>>,
  blockDecorationContainer: HTMLElement,
  openedMessageIds: Set<string>,
  setOpenMessageIds: (openedMessageIds: Set<string>) => void,
): void {
  const blockRowToMessages: Map<number, Array<DiagnosticMessage>> = new Map();
  rowToMessage.forEach((messages, row) => {
    if (
      messages.some(
        message =>
          message.kind === 'review' &&
          message.id != null &&
          openedMessageIds != null &&
          openedMessageIds.has(message.id),
      )
    ) {
      blockRowToMessages.set(row, messages);
    }
  });

  const fragment = (
    <>
      {Array.from(blockRowToMessages).map(([row, messages]) => {
        return (
          <BlockDecoration
            range={new Range([row, 0], [row, 0])}
            editor={editor}
            key={messages[0].id}>
            <Button
              onClick={() =>
                removeOpenMessageId(
                  messages,
                  openedMessageIds,
                  setOpenMessageIds,
                )
              }>
              Close
            </Button>
            {messages.map(message => {
              if (!message.getBlockComponent) {
                return null;
              }
              const Component = message.getBlockComponent();
              return <Component key={message.id} />;
            })}
          </BlockDecoration>
        );
      })}
    </>
  );
  ReactDOM.render(fragment, blockDecorationContainer);
}

function createGutterItem(
  editor: TextEditor,
  messages: Array<DiagnosticMessage>,
  diagnosticUpdater: DiagnosticUpdater,
  gutter: atom$Gutter,
  openedMessageIds: Set<string>,
  setOpenMessageIds: (openedMessageIds: Set<string>) => void,
  gutterMarker: atom$Marker,
): {item: HTMLElement, dispose: () => void} {
  // Determine which group to display.
  const messageGroups = new Set();
  messages.forEach(msg => messageGroups.add(GroupUtils.getGroup(msg)));
  const group = GroupUtils.getHighestPriorityGroup(messageGroups);

  const item = document.createElement('span');
  const groupClassName = GUTTER_CSS_GROUPS[group];
  item.className = classnames('diagnostics-gutter-ui-item', groupClassName, {
    'diagnostics-gutter-ui-gutter-stale': messages.every(
      message => message.stale,
    ),
  });

  // Add the icon
  const icon = document.createElement('span');
  icon.className = `icon icon-${GroupUtils.getIcon(group)}`;
  item.appendChild(icon);

  const editorElement = editor.getElement();
  const disposable = new UniversalDisposable(
    SpawnPopupEvents.subscribe(),
    Observable.fromEvent(item, 'mouseenter').subscribe(() => {
      handleSpawnPopupEvents.next({
        messages,
        diagnosticUpdater,
        gutter,
        item,
        editorElement,
        gutterMarker,
      });
    }),
    Observable.fromEvent(item, 'click').subscribe(() => {
      addOpenMessageId(messages, openedMessageIds, setOpenMessageIds);
    }),
  );

  return {
    item,
    dispose() {
      disposable.dispose();
    },
  };
}

function addOpenMessageId(
  messages: Array<DiagnosticMessage>,
  openedMessageIds: Set<string>,
  setOpenMessageIds: (openedMessageIds: Set<string>) => void,
) {
  const newOpenedMessageIds = new Set([...openedMessageIds]);
  messages.forEach(message => {
    if (message.id != null) {
      newOpenedMessageIds.add(message.id);
    }
  });
  // Closing block decoration is handled by editor destroy or close button
  // Only fire a set if there are new opened messages.
  if (newOpenedMessageIds.size > 0) {
    setOpenMessageIds(newOpenedMessageIds);
  }
}

function removeOpenMessageId(
  messages: Array<DiagnosticMessage>,
  openedMessageIds: Set<string>,
  setOpenMessageIds: (openedMessageIds: Set<string>) => void,
) {
  if (openedMessageIds.size === 0) {
    return;
  }
  const newOpenedMessageIds = new Set([...openedMessageIds]);
  messages.forEach(message => {
    if (message.id != null) {
      newOpenedMessageIds.delete(message.id);
    }
  });
  setOpenMessageIds(newOpenedMessageIds);
}

function spawnPopup(
  messages: Array<DiagnosticMessage>,
  diagnosticUpdater: DiagnosticUpdater,
  gutter: atom$Gutter,
  item: HTMLElement,
): Observable<HTMLElement> {
  return Observable.create(observer => {
    const goToLocation = (path: string, line: number) => {
      // Before we jump to the location, we want to close the popup.
      const column = 0;
      atomGoToLocation(path, {line, column});
      observer.complete();
    };

    const popupElement = showPopupFor(
      messages,
      item,
      goToLocation,
      diagnosticUpdater,
      gutter,
    );
    observer.next(popupElement);

    return () => {
      ReactDOM.unmountComponentAtNode(popupElement);
      invariant(popupElement.parentNode != null);
      popupElement.parentNode.removeChild(popupElement);
    };
  });
}

/**
 * Shows a popup for the diagnostic just below the specified item.
 */
function showPopupFor(
  messages: Array<DiagnosticMessage>,
  item: HTMLElement,
  goToLocation: (filePath: NuclideUri, line: number) => mixed,
  diagnosticUpdater: DiagnosticUpdater,
  gutter: atom$Gutter,
): HTMLElement {
  // The popup will be an absolutely positioned child element of <atom-workspace> so that it appears
  // on top of everything.
  const workspaceElement = atom.views.getView((atom.workspace: Object));
  const hostElement = document.createElement('div');
  hostElement.classList.add('diagnostics-gutter-popup');
  // $FlowFixMe check parentNode for null
  workspaceElement.parentNode.appendChild(hostElement);

  const {
    bottom: itemBottom,
    top: itemTop,
    height: itemHeight,
  } = item.getBoundingClientRect();
  // $FlowFixMe atom$Gutter.getElement is not a documented API, but it beats using a query selector.
  const gutterContainer = gutter.getElement();
  const {right: gutterRight} = gutterContainer.getBoundingClientRect();

  const trackedFixer = (...args) => {
    diagnosticUpdater.applyFix(...args);
    analytics.track('diagnostics-gutter-autofix');
  };
  const trackedGoToLocation = (filePath: NuclideUri, line: number) => {
    goToLocation(filePath, line);
    analytics.track('diagnostics-gutter-goto-location');
  };

  const editor = itemToEditor.get(item);
  invariant(editor != null);
  diagnosticUpdater.fetchCodeActions(editor, messages);
  diagnosticUpdater.fetchDescriptions(messages);

  const popupTop = itemBottom;
  const BoundPopup = makeDatatipComponent(messages, diagnosticUpdater, {
    fixer: trackedFixer,
    goToLocation: trackedGoToLocation,
    style: {left: gutterRight, top: popupTop, position: 'absolute'},
  });
  ReactDOM.render(<BoundPopup />, hostElement);

  // Check to see whether the popup is within the bounds of the TextEditor. If not, display it above
  // the glyph rather than below it.
  const editorElement = atom.views.getView(editor);
  const {
    top: editorTop,
    height: editorHeight,
  } = editorElement.getBoundingClientRect();

  const popupElement = hostElement.firstElementChild;
  invariant(popupElement instanceof HTMLElement);
  const popupHeight = popupElement.clientHeight;
  if (itemTop + itemHeight + popupHeight > editorTop + editorHeight) {
    // if the popup top is out of editor's top bound, position popup at top: 0px
    // so it does not get cutoff.
    const popupTopEdge = Math.max(0, popupTop - popupHeight - itemHeight);
    popupElement.style.top = `${popupTopEdge}px`;
  }

  try {
    return hostElement;
  } finally {
    messages.forEach(message => {
      analytics.track('diagnostics-gutter-show-popup', {
        'diagnostics-provider': message.providerName,
        // flowlint-next-line sketchy-null-string:off
        'diagnostics-message': message.text || message.html || '',
      });
    });
  }
}
