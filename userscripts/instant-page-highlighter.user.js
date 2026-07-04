// ==UserScript==
// @name         Instant Page Highlighter
// @namespace    https://github.com/KennFatt/instant-page-highlighter
// @version      1.0.0
// @description  Highlight text instantly on selection. Always-on.
// @author       KennFatt
// @match        *://*/*
// @grant        GM.getValue
// @grant        GM.setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = Object.freeze({
    STORAGE_PREFIX: 'highlights:',
    HIGHLIGHT_CLASS: 'auto-highlight-marker',
    DEFAULT_COLOR: '#b9f6b3',
    TAP_DELAY_MS: 350,
    CONFIRM_TIMEOUT_MS: 2500,
    SELECTION_DEBOUNCE_MS: 200,
    TRUNCATE_LIMIT: 100,
  });

  let lastTap = { id: null, time: 0 };
  let selectionDebounce = null;
  let highlightingEnabled = true;

  const pageKey = CONFIG.STORAGE_PREFIX + location.origin + location.pathname + location.search;

  init();

  async function init() {
    injectStyles();
    injectFloatingPanel();

    try {
      const saved = await getStoredHighlights();
      if (saved.length > 0) {
        restoreHighlights(saved);
      }
    } catch {
      // Storage unavailable; run without persistence.
    }

    updateClearButton();

    document.addEventListener('mouseup', onSelectionTrigger, true);
    document.addEventListener('keyup', onSelectionTrigger, true);
    document.addEventListener('touchend', onTouchEnd, true);
    document.addEventListener('dblclick', onDoubleClick, true);
    document.addEventListener('selectionchange', onSelectionChange, true);
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent =
      '.' +
      CONFIG.HIGHLIGHT_CLASS +
      ' {' +
      '  background: var(--instant-highlight-bg, #b9f6b3);' +
      '  color: var(--instant-highlight-fg, #111111);' +
      '  border-radius: 0.18em;' +
      '  box-shadow: 0 0 0 1px color-mix(in srgb, var(--instant-highlight-bg, #b9f6b3) 72%, #000 10%);' +
      '  cursor: pointer;' +
      '  transition: background-color 140ms ease, box-shadow 140ms ease, opacity 140ms ease;' +
      '  -webkit-box-decoration-break: clone;' +
      '  box-decoration-break: clone;' +
      '  padding: 0.02em 0.04em;' +
      '}' +
      '.' +
      CONFIG.HIGHLIGHT_CLASS +
      ':hover {' +
      '  box-shadow: 0 0 0 1px color-mix(in srgb, var(--instant-highlight-bg, #b9f6b3) 84%, #000 20%);' +
      '}';
    document.documentElement.appendChild(style);
  }

  async function getStoredHighlights() {
    const stored = await GM.getValue(pageKey, null);
    return Array.isArray(stored) ? stored : [];
  }

  function onSelectionChange() {
    if (selectionDebounce) {
      globalThis.clearTimeout(selectionDebounce);
    }
    selectionDebounce = globalThis.setTimeout(function () {
      onSelectionTrigger({ target: document });
    }, CONFIG.SELECTION_DEBOUNCE_MS);
  }

  function onTouchEnd(event) {
    const marker = event.target instanceof Element ? event.target.closest('.' + CONFIG.HIGHLIGHT_CLASS) : null;

    if (marker) {
      const id = marker.dataset.highlightId;
      const now = Date.now();
      if (id && lastTap.id === id && now - lastTap.time < CONFIG.TAP_DELAY_MS) {
        removeHighlight(id);
        lastTap = { id: null, time: 0 };
        event.preventDefault();
        return;
      }

      lastTap = { id: id, time: now };
    }

    // Selection is handled by the debounced selectionchange listener.
  }

  function onDoubleClick(event) {
    const marker = event.target instanceof Element ? event.target.closest('.' + CONFIG.HIGHLIGHT_CLASS) : null;

    if (!marker) {
      return;
    }

    const id = marker.dataset.highlightId;
    if (id) {
      removeHighlight(id);
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onSelectionTrigger(event) {
    if (!highlightingEnabled) {
      return;
    }

    if (event.target instanceof Element && event.target.closest('.' + CONFIG.HIGHLIGHT_CLASS)) {
      return;
    }

    const selection = globalThis.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (!isValidRange(range)) {
      return;
    }

    const text = selection.toString().trim();
    if (!text) {
      return;
    }

    const serialized = serializeRange(range);
    if (!serialized) {
      return;
    }

    const record = {
      startOffset: serialized.startOffset,
      endOffset: serialized.endOffset,
      id: createId(),
      color: CONFIG.DEFAULT_COLOR,
      text: text,
    };

    applyHighlight(record);
    saveHighlight(record);
    selection.removeAllRanges();
  }

  function isValidRange(range) {
    if (!range || range.collapsed) {
      return false;
    }

    const ancestor = range.commonAncestorContainer;
    if (!document.body.contains(ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentNode)) {
      return false;
    }

    return !hasHighlightAncestor(range.startContainer) && !hasHighlightAncestor(range.endContainer);
  }

  function hasHighlightAncestor(node) {
    let current = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (current) {
      if (current.classList?.contains(CONFIG.HIGHLIGHT_CLASS)) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function serializeRange(range) {
    const start = normalizeBoundary(range.startContainer, range.startOffset);
    const end = normalizeBoundary(range.endContainer, range.endOffset);

    if (!start || !end) {
      return null;
    }

    return {
      startOffset: getGlobalOffset(start.node, start.offset),
      endOffset: getGlobalOffset(end.node, end.offset),
    };
  }

  function normalizeBoundary(container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
      return { node: container, offset: offset };
    }

    const textNodes = getTextNodes(container);
    if (!textNodes.length) {
      return null;
    }

    if (offset <= 0) {
      return { node: textNodes[0], offset: 0 };
    }

    if (offset >= container.childNodes.length) {
      const lastNode = textNodes.at(-1);
      return {
        node: lastNode,
        offset: lastNode.textContent.length,
      };
    }

    const child = container.childNodes[offset];
    const firstText = getFirstTextNode(child);
    if (firstText) {
      return { node: firstText, offset: 0 };
    }

    for (let i = offset - 1; i >= 0; i -= 1) {
      const previous = getLastTextNode(container.childNodes[i]);
      if (previous) {
        return {
          node: previous,
          offset: previous.textContent.length,
        };
      }
    }

    return null;
  }

  function restoreHighlights(records) {
    const sorted = records.slice().sort(function (left, right) {
      return right.startOffset - left.startOffset;
    });
    for (const element of sorted) {
      applyHighlight(element);
    }
  }

  function applyHighlight(record) {
    const range = deserializeRange(record);
    if (!range || range.collapsed) {
      return;
    }
    wrapRange(range, record.id, record.color || CONFIG.DEFAULT_COLOR);
  }

  function deserializeRange(record) {
    const startPosition = getTextPositionAtOffset(record.startOffset);
    const endPosition = getTextPositionAtOffset(record.endOffset);

    if (!startPosition || !endPosition) {
      return null;
    }

    const range = document.createRange();
    try {
      range.setStart(startPosition.node, clampOffset(startPosition.offset, startPosition.node.textContent.length));
      range.setEnd(endPosition.node, clampOffset(endPosition.offset, endPosition.node.textContent.length));
      return range;
    } catch {
      return null;
    }
  }

  function wrapRange(range, id, color) {
    const textNodes = getIntersectingTextNodes(range);
    const textColor = pickReadableTextColor(color);

    for (const element of textNodes) {
      const node = element;
      const startOffset = node === range.startContainer ? range.startOffset : 0;
      const endOffset = node === range.endContainer ? range.endOffset : node.textContent.length;

      if (startOffset === endOffset) {
        continue;
      }

      const wrappedNode = splitTextNode(node, startOffset, endOffset);
      if (!wrappedNode?.parentNode) {
        continue;
      }

      const marker = document.createElement('span');
      marker.className = CONFIG.HIGHLIGHT_CLASS;
      marker.dataset.highlightId = id;
      marker.style.setProperty('--instant-highlight-bg', color);
      marker.style.setProperty('--instant-highlight-fg', textColor);
      wrappedNode.parentNode.insertBefore(marker, wrappedNode);
      marker.appendChild(wrappedNode);
    }
  }

  function splitTextNode(node, startOffset, endOffset) {
    let target = node;

    if (startOffset > 0) {
      target = node.splitText(startOffset);
    }

    const length = endOffset - startOffset;
    if (length < target.textContent.length) {
      target.splitText(length);
    }

    return target;
  }

  function getIntersectingTextNodes(range) {
    const ancestor =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentNode;
    const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.textContent.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        if (hasHighlightAncestor(node)) {
          return NodeFilter.FILTER_REJECT;
        }
        return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const nodes = [];
    let current = walker.nextNode();
    while (current) {
      nodes.push(current);
      current = walker.nextNode();
    }
    return nodes;
  }

  async function saveHighlight(record) {
    try {
      const records = await getStoredHighlights();
      records.push(record);
      await GM.setValue(pageKey, records);
      updateClearButton();
      const infoPanel = document.getElementById('ih-info-panel');
      if (infoPanel?.classList.contains('ih-info-open')) {
        populateInfoPanel();
      }
    } catch {
      // Storage unavailable; highlight is visual-only for this session.
    }
  }

  async function removeHighlight(id) {
    unwrapHighlight(id);

    try {
      const records = await getStoredHighlights();
      const next = [];
      for (const element of records) {
        if (element.id !== id) {
          next.push(element);
        }
      }
      await GM.setValue(pageKey, next);
      updateClearButton();
    } catch {
      // Storage unavailable; removal is visual-only for this session.
    }
  }

  function unwrapHighlight(id) {
    const markers = document.querySelectorAll('.' + CONFIG.HIGHLIGHT_CLASS + '[data-highlight-id="' + id + '"]');
    for (const marker of markers) {
      const parent = marker.parentNode;
      if (!parent) {
        continue;
      }
      while (marker.firstChild) {
        parent.insertBefore(marker.firstChild, marker);
      }
      marker.remove();
      parent.normalize();
    }
  }

  function injectFloatingPanel() {
    const container = document.createElement('div');
    container.id = 'ih-container';
    container.appendChild(createInfoPanel());
    container.appendChild(createButtonPanel());

    const style = document.createElement('style');
    style.textContent = getPanelStyles();
    document.documentElement.appendChild(style);
    document.body.appendChild(container);

    registerPanelListeners();
  }

  function createInfoPanel() {
    const panel = document.createElement('div');
    panel.id = 'ih-info-panel';
    panel.innerHTML = '<div id="ih-info-header">Highlights</div>' + '<div id="ih-info-list"></div>';
    return panel;
  }

  function createButtonPanel() {
    const panel = document.createElement('div');
    panel.id = 'instant-highlight-panel';
    panel.innerHTML =
      '<button id="ih-dismiss" title="Hide panel for this session">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">' +
      '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>' +
      '</svg>' +
      '</button>' +
      '<button id="ih-info" title="Show highlighted text list">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">' +
      '<path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zm0-8h14V7H7v2z"/>' +
      '</svg>' +
      '</button>' +
      '<button id="ih-toggle" title="Toggle highlighting on/off">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">' +
      '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>' +
      '</svg>' +
      '</button>' +
      '<button id="ih-clear" title="Remove all highlights">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">' +
      '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>' +
      '</svg>' +
      '</button>';
    return panel;
  }

  function registerPanelListeners() {
    document.getElementById('ih-dismiss').addEventListener('click', function () {
      confirmThenAct(this, dismissFloatingPanel);
    });
    document.getElementById('ih-info').addEventListener('click', toggleInfoPanel);
    document.getElementById('ih-toggle').addEventListener('click', toggleHighlighting);
    document.getElementById('ih-clear').addEventListener('click', function () {
      confirmThenAct(this, clearAllHighlights);
    });
  }

  function getPanelStyles() {
    return (
      '#ih-container {' +
      '  position: fixed;' +
      '  top: 50%;' +
      '  right: 12px;' +
      '  transform: translateY(-50%);' +
      '  z-index: 2147483647;' +
      '  display: flex;' +
      '  align-items: center;' +
      '  -webkit-user-select: none;' +
      '  user-select: none;' +
      '  gap: 8px;' +
      '}' +
      '#instant-highlight-panel {' +
      '  display: flex;' +
      '  flex-direction: column;' +
      '  gap: 4px;' +
      '}' +
      '#instant-highlight-panel button {' +
      '  display: flex;' +
      '  position: relative;' +
      '  align-items: center;' +
      '  justify-content: center;' +
      '  width: 32px;' +
      '  height: 32px;' +
      '  padding: 0;' +
      '  border: 1px solid rgba(0,0,0,0.1);' +
      '  border-radius: 6px;' +
      '  background: rgba(255,255,255,0.82);' +
      '  color: #555;' +
      '  cursor: pointer;' +
      '  opacity: 0.6;' +
      '  backdrop-filter: blur(4px);' +
      '  box-shadow: 0 1px 3px rgba(0,0,0,0.06);' +
      '  transition: opacity 120ms ease, background 120ms ease, color 120ms ease;' +
      '}' +
      '#instant-highlight-panel button:hover {' +
      '  opacity: 1;' +
      '  background: #fff;' +
      '  color: #111;' +
      '}' +
      '#ih-toggle.off {' +
      '  opacity: 0.5;' +
      '  background: rgba(255,235,235,0.7);' +
      '  border-color: rgba(180,80,80,0.25);' +
      '  color: #b44;' +
      '}' +
      '#ih-clear:hover {' +
      '  color: #c33;' +
      '}' +
      '#ih-dismiss:hover {' +
      '  color: #999;' +
      '}' +
      '.ih-confirm {' +
      '  border-color: rgba(200,120,0,0.5) !important;' +
      '  color: #b80 !important;' +
      '}' +
      '.ih-confirm-ring {' +
      '  position: absolute;' +
      '  inset: -3px;' +
      '  border-radius: 9px;' +
      '  background: conic-gradient(rgba(200,120,0,0.55) 0deg, rgba(200,120,0,0.55) 90deg, transparent 90deg, transparent 360deg);' +
      '  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1px));' +
      '  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1px));' +
      '  animation: ih-ring-sweep 1s linear forwards;' +
      '  pointer-events: none;' +
      '}' +
      '@keyframes ih-ring-sweep {' +
      '  from { transform: rotate(0deg); }' +
      '  to { transform: rotate(360deg); }' +
      '}' +
      '#ih-info-panel {' +
      '  width: 220px;' +
      '  height: 240px;' +
      '  background: rgba(255,255,255,0.82);' +
      '  backdrop-filter: blur(4px);' +
      '  border: 1px solid rgba(0,0,0,0.1);' +
      '  border-radius: 8px;' +
      '  box-shadow: 0 1px 3px rgba(0,0,0,0.06);' +
      '  opacity: 0;' +
      '  transform: translateX(8px);' +
      '  transition: opacity 150ms ease, transform 150ms ease;' +
      '  pointer-events: none;' +
      '  overflow: hidden;' +
      '  display: flex;' +
      '  flex-direction: column;' +
      '}' +
      '#ih-info-panel.ih-info-open {' +
      '  opacity: 1;' +
      '  transform: translateX(0);' +
      '  pointer-events: auto;' +
      '}' +
      '#ih-info-header {' +
      '  padding: 8px 10px;' +
      '  font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
      '  color: #888;' +
      '  border-bottom: 1px solid rgba(0,0,0,0.06);' +
      '  flex-shrink: 0;' +
      '}' +
      '#ih-info-list {' +
      '  flex: 1;' +
      '  overflow-y: auto;' +
      '  padding: 4px 0;' +
      '}' +
      '.ih-info-item {' +
      '  padding: 6px 10px;' +
      '  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
      '  color: #444;' +
      '  cursor: pointer;' +
      '  white-space: nowrap;' +
      '  overflow: hidden;' +
      '  text-overflow: ellipsis;' +
      '  transition: background 100ms ease;' +
      '}' +
      '.ih-info-item:hover {' +
      '  background: rgba(0,0,0,0.04);' +
      '  color: #111;' +
      '}' +
      '.ih-info-empty {' +
      '  padding: 24px 10px;' +
      '  text-align: center;' +
      '  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
      '  color: #aaa;' +
      '}'
    );
  }

  function dismissFloatingPanel() {
    const container = document.getElementById('ih-container');
    if (container) container.style.display = 'none';
  }

  function confirmThenAct(button, action) {
    if (button.dataset.ihConfirmTimer) {
      clearTimeout(Number(button.dataset.ihConfirmTimer));
      delete button.dataset.ihConfirmTimer;
      resetConfirmButton(button);
      action();
      return;
    }

    button.dataset.ihPrevHtml = button.innerHTML;

    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/></svg>';
    button.classList.add('ih-confirm');

    const ring = document.createElement('div');
    ring.className = 'ih-confirm-ring';
    button.appendChild(ring);

    const timer = setTimeout(function () {
      resetConfirmButton(button);
    }, CONFIG.CONFIRM_TIMEOUT_MS);

    button.dataset.ihConfirmTimer = String(timer);
  }

  function resetConfirmButton(button) {
    const prevTimer = Number(button.dataset.ihConfirmTimer);
    if (prevTimer) {
      clearTimeout(prevTimer);
    }
    delete button.dataset.ihConfirmTimer;

    const prevHtml = button.dataset.ihPrevHtml;
    if (prevHtml) {
      button.innerHTML = prevHtml;
      delete button.dataset.ihPrevHtml;
    }

    button.classList.remove('ih-confirm');
    const ring = button.querySelector('.ih-confirm-ring');
    if (ring) ring.remove();
  }

  function toggleInfoPanel() {
    const panel = document.getElementById('ih-info-panel');
    const isOpen = panel.classList.toggle('ih-info-open');
    if (isOpen) {
      populateInfoPanel();
    }
  }

  function populateInfoPanel() {
    const markers = document.querySelectorAll('.' + CONFIG.HIGHLIGHT_CLASS);
    const list = document.getElementById('ih-info-list');
    list.innerHTML = '';

    if (markers.length === 0) {
      list.innerHTML = '<div class="ih-info-empty">No highlights</div>';
      return;
    }

    const groups = new Map();
    for (const marker of markers) {
      const id = marker.dataset.highlightId;
      if (!id) continue;
      if (!groups.has(id)) {
        groups.set(id, { id, texts: [] });
      }
      groups.get(id).texts.push(marker.textContent);
    }

    for (const [, group] of groups) {
      const fullText = group.texts.join('');
      const item = document.createElement('div');
      item.className = 'ih-info-item';
      item.title = fullText;
      item.textContent =
        fullText.length > CONFIG.TRUNCATE_LIMIT ? fullText.slice(0, CONFIG.TRUNCATE_LIMIT - 3) + '...' : fullText;
      item.dataset.highlightId = group.id;
      item.addEventListener('click', function (e) {
        scrollToHighlight(this.dataset.highlightId);
        document.getElementById('ih-info-panel').classList.remove('ih-info-open');
      });
      list.appendChild(item);
    }
  }

  function scrollToHighlight(id) {
    const marker = document.querySelector('.' + CONFIG.HIGHLIGHT_CLASS + '[data-highlight-id="' + id + '"]');
    if (marker) {
      marker.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function toggleHighlighting() {
    highlightingEnabled = !highlightingEnabled;
    document.getElementById('ih-toggle').classList.toggle('off', !highlightingEnabled);
  }

  function updateClearButton() {
    const button = document.getElementById('ih-clear');
    if (!button) return;
    const hasHighlights = document.querySelector('.' + CONFIG.HIGHLIGHT_CLASS) !== null;
    button.style.display = hasHighlights ? '' : 'none';
  }

  async function clearAllHighlights() {
    let records;
    try {
      records = await getStoredHighlights();
    } catch {
      records = [];
    }
    for (const record of records) {
      unwrapHighlight(record.id);
    }
    try {
      await GM.setValue(pageKey, []);
    } catch {
      // Storage unavailable; visual clear is sufficient.
    }
    updateClearButton();
    const infoPanel = document.getElementById('ih-info-panel');
    if (infoPanel) infoPanel.classList.remove('ih-info-open');
  }

  function getTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let current = walker.nextNode();
    while (current) {
      if (current.textContent.trim()) {
        nodes.push(current);
      }
      current = walker.nextNode();
    }
    return nodes;
  }

  function getFirstTextNode(root) {
    if (!root) {
      return null;
    }
    if (root.nodeType === Node.TEXT_NODE) {
      return root;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    return walker.nextNode();
  }

  function getLastTextNode(root) {
    if (!root) {
      return null;
    }
    if (root.nodeType === Node.TEXT_NODE) {
      return root;
    }
    const nodes = getTextNodes(root);
    return nodes.at(-1) || null;
  }

  function clampOffset(offset, max) {
    return Math.max(0, Math.min(offset, max));
  }

  function getGlobalOffset(targetNode, targetOffset) {
    let total = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();

    while (current) {
      if (current === targetNode) {
        return total + clampOffset(targetOffset, current.textContent.length);
      }
      total += current.textContent.length;
      current = walker.nextNode();
    }
    return total;
  }

  function getTextPositionAtOffset(targetOffset) {
    const safeOffset = Math.max(0, targetOffset);
    let total = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    let lastTextNode = null;

    while (current) {
      const length = current.textContent.length;
      if (safeOffset <= total + length) {
        return {
          node: current,
          offset: safeOffset - total,
        };
      }
      total += length;
      lastTextNode = current;
      current = walker.nextNode();
    }

    if (!lastTextNode) {
      return null;
    }
    return {
      node: lastTextNode,
      offset: lastTextNode.textContent.length,
    };
  }

  function createId() {
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'hl-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function pickReadableTextColor(backgroundHex) {
    const rgb = hexToRgb(backgroundHex);
    if (!rgb) {
      return '#111111';
    }
    const whiteContrast = contrastRatio(rgb, { r: 255, g: 255, b: 255 });
    const blackContrast = contrastRatio(rgb, { r: 17, g: 17, b: 17 });
    return blackContrast >= whiteContrast ? '#111111' : '#ffffff';
  }

  function hexToRgb(value) {
    const normalized = value.replace('#', '');
    if (normalized.length !== 3 && normalized.length !== 6) {
      return null;
    }
    const full =
      normalized.length === 3
        ? normalized.charAt(0) +
          normalized.charAt(0) +
          normalized.charAt(1) +
          normalized.charAt(1) +
          normalized.charAt(2) +
          normalized.charAt(2)
        : normalized;
    const int = Number.parseInt(full, 16);
    if (Number.isNaN(int)) {
      return null;
    }
    return {
      r: (int >> 16) & 255,
      g: (int >> 8) & 255,
      b: int & 255,
    };
  }

  function contrastRatio(colorA, colorB) {
    const luminanceA = relativeLuminance(colorA);
    const luminanceB = relativeLuminance(colorB);
    const lighter = Math.max(luminanceA, luminanceB);
    const darker = Math.min(luminanceA, luminanceB);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function relativeLuminance(color) {
    const r = color.r,
      g = color.g,
      b = color.b;
    const redLum = channelLuminance(r);
    const greenLum = channelLuminance(g);
    const blueLum = channelLuminance(b);
    return 0.2126 * redLum + 0.7152 * greenLum + 0.0722 * blueLum;
  }

  function channelLuminance(channel) {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  }
})();
