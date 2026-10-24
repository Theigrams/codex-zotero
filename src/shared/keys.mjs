// Keyboard shortcuts the user can rebind in the settings drawer. A binding is a combo string such as
// "Alt+ArrowLeft", "Meta+f" or "g". Fixed, not rebindable: 1–9 (annotation colors, ⇧ for underline),
// Esc, ⌘C, ⌘1–9 (tabs). Back and forward default to ⌥← / ⌥→: ⌘[ is taken by the Codex app itself.

export const ACTIONS = [
  { id: 'back', label: '返回（链接跳转前的位置）', key: 'Alt+ArrowLeft' },
  { id: 'forward', label: '前进', key: 'Alt+ArrowRight' },
  { id: 'find', label: '在本文中查找', key: 'Meta+f' },
  { id: 'gotoPage', label: '跳页', key: 'g' },
  { id: 'highlight', label: '用第一种颜色高亮', key: 'h' },
  { id: 'drawer', label: '批注抽屉 / 笔记目录', key: 'a' },
  { id: 'zoomIn', label: '放大', key: '=' },
  { id: 'zoomOut', label: '缩小', key: '-' },
  { id: 'fitWidth', label: '适应宽度', key: '0' },
  { id: 'crop', label: '裁边 / 原始页面', key: 'c' },
  { id: 'undo', label: '恢复刚删除的批注', key: 'Meta+z' },
  { id: 'closeTab', label: '关闭当前标签', key: 'Meta+w' },
  { id: 'settings', label: '设置', key: 'Meta+,' },
  { id: 'debug', label: '调试行', key: 'Shift+d' },
];

export const DEFAULT_KEYS = Object.fromEntries(ACTIONS.map(a => [a.id, a.key]));

// The physical key for letters and digits (⌥F gives "ƒ" as e.key on a Mac), the key value otherwise.
export function comboOf(e) {
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', key].filter(Boolean).join('+');
}

// Combos the settings refuse: they belong to fixed functions.
export function reserved(combo) {
  return /^(Shift\+)?[1-9]$/.test(combo) || combo === 'Escape' || /^Meta\+([1-9]|c)$/.test(combo);
}

const SYMBOL = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Enter: '↩', Backspace: '⌫', ' ': '空格' };

export function showCombo(combo) {
  if (!combo) return '未设置';
  return combo.split(/\+(?=.)/).map(p => SYMBOL[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join('');
}

// The bindings in effect: defaults overridden by the user's (null = unbound).
export const keymap = custom => ({ ...DEFAULT_KEYS, ...(custom || {}) });

export function actionFor(map, combo) {
  return Object.keys(map).find(id => map[id] === combo) || null;
}
