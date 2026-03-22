const MODE_KEY = "modeEnabled";
const STORAGE_PREFIX = "highlights:";
const HIGHLIGHT_CLASS = "auto-highlight-marker";
const DEFAULT_COLOR = "#b9f6b3";
const TAP_DELAY_MS = 350;

let modeEnabled = false;
let toastTimer = null;
let lastTap = { id: null, time: 0 };

const pageKey = `${STORAGE_PREFIX}${location.origin}${location.pathname}${location.search}`;

init().catch(() => {
  // Keep the page usable even if initialization fails.
});

async function init() {
  const stored = await chrome.storage.local.get([MODE_KEY, pageKey]);
  modeEnabled = Boolean(stored[MODE_KEY]);
  restoreHighlights(stored[pageKey] || []);

  document.addEventListener("mouseup", onSelectionTrigger, true);
  document.addEventListener("keyup", onSelectionTrigger, true);
  document.addEventListener("touchend", onTouchEnd, true);
  document.addEventListener("dblclick", onDoubleClick, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "MODE_CHANGED") {
      modeEnabled = Boolean(message.enabled);
      showToast(modeEnabled ? "Highlight mode on" : "Highlight mode off");
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[MODE_KEY]) {
      modeEnabled = Boolean(changes[MODE_KEY].newValue);
    }
  });
}

function onTouchEnd(event) {
  const marker = event.target instanceof Element
    ? event.target.closest(`.${HIGHLIGHT_CLASS}`)
    : null;

  if (marker) {
    const id = marker.dataset.highlightId;
    const now = Date.now();
    if (id && lastTap.id === id && now - lastTap.time < TAP_DELAY_MS) {
      removeHighlight(id);
      lastTap = { id: null, time: 0 };
      event.preventDefault();
      return;
    }

    lastTap = { id, time: now };
    return;
  }

  window.setTimeout(() => {
    void onSelectionTrigger(event);
  }, 0);
}

function onDoubleClick(event) {
  const marker = event.target instanceof Element
    ? event.target.closest(`.${HIGHLIGHT_CLASS}`)
    : null;

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

async function onSelectionTrigger(event) {
  if (!modeEnabled) {
    return;
  }

  if (event.target instanceof Element && event.target.closest(`.${HIGHLIGHT_CLASS}`)) {
    return;
  }

  const selection = window.getSelection();
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
    ...serialized,
    id: createId(),
    color: DEFAULT_COLOR,
    text
  };

  applyHighlight(record);
  await saveHighlight(record);
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
    if (current.classList?.contains(HIGHLIGHT_CLASS)) {
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
    endOffset: getGlobalOffset(end.node, end.offset)
  };
}

function normalizeBoundary(container, offset) {
  if (container.nodeType === Node.TEXT_NODE) {
    return { node: container, offset };
  }

  const textNodes = getTextNodes(container);
  if (!textNodes.length) {
    return null;
  }

  if (offset <= 0) {
    return { node: textNodes[0], offset: 0 };
  }

  if (offset >= container.childNodes.length) {
    const lastNode = textNodes[textNodes.length - 1];
    return { node: lastNode, offset: lastNode.textContent.length };
  }

  const child = container.childNodes[offset];
  const firstText = getFirstTextNode(child);
  if (firstText) {
    return { node: firstText, offset: 0 };
  }

  for (let index = offset - 1; index >= 0; index -= 1) {
    const previous = getLastTextNode(container.childNodes[index]);
    if (previous) {
      return { node: previous, offset: previous.textContent.length };
    }
  }

  return null;
}

function restoreHighlights(records) {
  const sorted = [...records].sort((left, right) => right.startOffset - left.startOffset);
  for (const record of sorted) {
    applyHighlight(record);
  }
}

function applyHighlight(record) {
  const range = deserializeRange(record);
  if (!range || range.collapsed) {
    return;
  }

  wrapRange(range, record.id, record.color || DEFAULT_COLOR);
}

function deserializeRange(record) {
  const startPosition = getTextPositionAtOffset(record.startOffset);
  const endPosition = getTextPositionAtOffset(record.endOffset);

  if (!startPosition || !endPosition) {
    return null;
  }

  const range = document.createRange();
  try {
    range.setStart(
      startPosition.node,
      clampOffset(startPosition.offset, startPosition.node.textContent.length)
    );
    range.setEnd(
      endPosition.node,
      clampOffset(endPosition.offset, endPosition.node.textContent.length)
    );
    return range;
  } catch (error) {
    return null;
  }
}

function wrapRange(range, id, color) {
  const textNodes = getIntersectingTextNodes(range);
  const textColor = pickReadableTextColor(color);

  for (const node of textNodes) {
    const startOffset = node === range.startContainer ? range.startOffset : 0;
    const endOffset = node === range.endContainer ? range.endOffset : node.textContent.length;

    if (startOffset === endOffset) {
      continue;
    }

    const wrappedNode = splitTextNode(node, startOffset, endOffset);
    if (!wrappedNode || !wrappedNode.parentNode) {
      continue;
    }

    const marker = document.createElement("span");
    marker.className = HIGHLIGHT_CLASS;
    marker.dataset.highlightId = id;
    marker.style.setProperty("--instant-highlight-bg", color);
    marker.style.setProperty("--instant-highlight-fg", textColor);
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
  const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentNode;
  const walker = document.createTreeWalker(
    ancestor,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.textContent.trim()) {
          return NodeFilter.FILTER_REJECT;
        }

        if (hasHighlightAncestor(node)) {
          return NodeFilter.FILTER_REJECT;
        }

        return range.intersectsNode(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    }
  );

  const nodes = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current);
    current = walker.nextNode();
  }
  return nodes;
}

async function saveHighlight(record) {
  const stored = await chrome.storage.local.get(pageKey);
  const records = Array.isArray(stored[pageKey]) ? stored[pageKey] : [];
  records.push(record);
  await chrome.storage.local.set({ [pageKey]: records });
}

async function removeHighlight(id) {
  unwrapHighlight(id);

  const stored = await chrome.storage.local.get(pageKey);
  const records = Array.isArray(stored[pageKey]) ? stored[pageKey] : [];
  const next = records.filter((record) => record.id !== id);
  await chrome.storage.local.set({ [pageKey]: next });
}

function unwrapHighlight(id) {
  const markers = document.querySelectorAll(`.${HIGHLIGHT_CLASS}[data-highlight-id="${id}"]`);
  for (const marker of markers) {
    const parent = marker.parentNode;
    if (!parent) {
      continue;
    }

    while (marker.firstChild) {
      parent.insertBefore(marker.firstChild, marker);
    }
    parent.removeChild(marker);
    parent.normalize();
  }
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
  return nodes[nodes.length - 1] || null;
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
        offset: safeOffset - total
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
    offset: lastTextNode.textContent.length
  };
}

function createId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `hl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pickReadableTextColor(backgroundHex) {
  const rgb = hexToRgb(backgroundHex);
  if (!rgb) {
    return "#111111";
  }

  const whiteContrast = contrastRatio(rgb, { r: 255, g: 255, b: 255 });
  const blackContrast = contrastRatio(rgb, { r: 17, g: 17, b: 17 });
  return blackContrast >= whiteContrast ? "#111111" : "#ffffff";
}

function hexToRgb(value) {
  const normalized = value.replace("#", "");
  if (![3, 6].includes(normalized.length)) {
    return null;
  }

  const full = normalized.length === 3
    ? normalized.split("").map((part) => part + part).join("")
    : normalized;

  const int = Number.parseInt(full, 16);
  if (Number.isNaN(int)) {
    return null;
  }

  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255
  };
}

function contrastRatio(colorA, colorB) {
  const luminanceA = relativeLuminance(colorA);
  const luminanceB = relativeLuminance(colorB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance({ r, g, b }) {
  const [sr, sg, sb] = [r, g, b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return (0.2126 * sr) + (0.7152 * sg) + (0.0722 * sb);
}

function showToast(message) {
  let toast = document.querySelector(".instant-highlight-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "instant-highlight-toast";
    document.documentElement.appendChild(toast);
  }

  toast.textContent = message;
  toast.dataset.visible = "true";

  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }

  toastTimer = window.setTimeout(() => {
    toast.dataset.visible = "false";
  }, 1200);
}
