/**
 * Prompt Boost UI 样式（注入 Shadow DOM）。
 * 使用语义变量 + color-scheme，同时适配深色/浅色主题。
 */
export const boostStyles = `
:host {
  all: initial;
  --pb-text: #303030;
  --pb-text-dim: #6b6b6b;
  --pb-bg: #ffffff;
  --pb-border: rgba(0, 0, 0, 0.12);
  --pb-accent: #10a37f;
  --pb-accent-hover: #0e906f;
  --pb-danger: #d94343;
  --pb-shadow: rgba(0, 0, 0, 0.15);
}
:host([data-theme="dark"]) {
  --pb-text: #ececec;
  --pb-text-dim: #9b9b9b;
  --pb-bg: #212121;
  --pb-border: rgba(255, 255, 255, 0.14);
  --pb-shadow: rgba(0, 0, 0, 0.5);
}
* {
  box-sizing: border-box;
}
.pb-root {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC",
    "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1;
  color: var(--pb-text);
}
.pb-boost,
.pb-trigger {
  appearance: none;
  border: 1px solid var(--pb-border);
  background: var(--pb-bg);
  color: var(--pb-text);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  white-space: nowrap;
}
.pb-boost {
  padding: 5px 10px;
}
.pb-trigger {
  padding: 5px 6px;
  line-height: 1;
}
.pb-boost:hover:not(:disabled),
.pb-trigger:hover {
  background: rgba(16, 163, 127, 0.1);
  border-color: var(--pb-accent);
  color: var(--pb-accent);
}
.pb-boost:focus-visible,
.pb-trigger:focus-visible {
  outline: 2px solid var(--pb-accent);
  outline-offset: 1px;
}
.pb-boost:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.pb-trigger-wrap {
  position: relative;
}
.pb-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  min-width: 180px;
  background: var(--pb-bg);
  border: 1px solid var(--pb-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px var(--pb-shadow);
  padding: 4px;
  z-index: 2147483000;
}
.pb-menu-title {
  padding: 6px 8px;
  font-size: 11px;
  color: var(--pb-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.pb-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 8px;
  border: none;
  background: transparent;
  color: var(--pb-text);
  font-size: 13px;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
}
.pb-menu-item:hover {
  background: rgba(16, 163, 127, 0.1);
  color: var(--pb-accent);
}
.pb-menu-sep {
  height: 1px;
  background: var(--pb-border);
  margin: 4px 0;
}
.pb-nav-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pb-nav-label {
  flex: 0 0 auto;
}
.pb-nav-value {
  flex: 1 1 auto;
  text-align: right;
  color: var(--pb-text-dim);
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pb-nav-value[data-stale] {
  color: var(--pb-danger);
}
.pb-nav-arrow {
  color: var(--pb-text-dim);
  flex: 0 0 auto;
}
.pb-back-row {
  color: var(--pb-text-dim);
  font-size: 12px;
  margin-top: 2px;
}
.pb-radio-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pb-radio-dot {
  flex: 0 0 auto;
  color: var(--pb-text-dim);
  font-size: 11px;
}
.pb-radio-checked {
  color: var(--pb-accent);
  font-weight: 600;
}
.pb-radio-checked .pb-radio-dot {
  color: var(--pb-accent);
}
.pb-radio-label {
  flex: 1 1 auto;
}
.pb-radio-hint {
  font-size: 11px;
  color: var(--pb-text-dim);
  margin: -2px 0 6px 24px;
}
.pb-submenu {
  min-width: 220px;
}
.pb-score-pane {
  min-width: 260px;
}
.pb-score-total {
  font-size: 28px;
  font-weight: 700;
  color: var(--pb-accent);
  padding: 0 8px 8px;
}
.pb-score-total-max {
  font-size: 14px;
  color: var(--pb-text-dim);
  font-weight: 400;
}
.pb-score-row-val {
  color: var(--pb-text-dim);
  font-variant-numeric: tabular-nums;
}
.pb-score-source {
  margin-top: 10px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--pb-text-dim);
}
.pb-score-stale {
  padding: 8px;
  font-size: 12px;
  color: var(--pb-text-dim);
  line-height: 1.5;
}
.pb-conflict-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  justify-content: flex-end;
}
.pb-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 2147483003;
  background: var(--pb-bg);
  border: 1px solid var(--pb-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px var(--pb-shadow);
  padding: 10px 14px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--pb-text);
}
.pb-toast-undo {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--pb-accent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  padding: 0;
}
.pb-toast-undo:hover {
  text-decoration: underline;
}
.pb-banner {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 2147483001;
  background: var(--pb-bg);
  border: 1px solid var(--pb-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px var(--pb-shadow);
  padding: 10px 14px;
  font-size: 13px;
  max-width: 320px;
  color: var(--pb-text);
}
.pb-banner[data-kind="error"] {
  border-color: var(--pb-danger);
}
.pb-overlay-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483002;
  background: rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  justify-content: center;
}
.pb-panel {
  background: var(--pb-bg);
  border: 1px solid var(--pb-border);
  border-radius: 10px;
  box-shadow: 0 8px 32px var(--pb-shadow);
  padding: 16px;
  width: min(420px, 90vw);
  max-height: 80vh;
  overflow: auto;
  color: var(--pb-text);
}
.pb-panel h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.pb-panel .pb-close {
  float: right;
  border: none;
  background: transparent;
  color: var(--pb-text-dim);
  cursor: pointer;
  font-size: 16px;
}
.pb-score-row {
  display: flex;
  justify-content: space-between;
  margin: 4px 0;
  font-size: 13px;
}
.pb-score-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--pb-border);
  overflow: hidden;
  margin: 2px 0 6px;
}
.pb-score-fill {
  height: 100%;
  background: var(--pb-accent);
  border-radius: 3px;
}
.pb-dim-title {
  font-weight: 600;
  margin-top: 10px;
  font-size: 13px;
}
.pb-missing {
  color: var(--pb-danger);
  font-size: 12px;
  margin: 2px 0 0;
}
.pb-hint {
  color: var(--pb-text-dim);
  font-size: 12px;
  margin: 8px 0 0;
}
`;
