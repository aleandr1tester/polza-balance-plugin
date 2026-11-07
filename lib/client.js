/**
 * dsh-polza-balance — browser half of the polza.ai balance overlay widget.
 *
 * WHAT THIS FILE DOES (audit map)
 * - Renders one fixed-position card into the DSH Web GUI overlay slot
 *   (`shell.overlay`) plus a small settings panel. No other UI is touched.
 * - Network: exactly ONE request path, `mcpCall()` below. It POSTs a JSON-RPC
 *   `tools/call` to `settings.endpoint` (default `https://polza.ai/api/mcp`)
 *   with the user's token in the `Authorization` header. There are no other
 *   fetches, no script tags, no images/beacons, no telemetry.
 * - Storage: only `window.localStorage` keys `dsh-polza-balance:settings` and
 *   `dsh-polza-balance:position`. Nothing is written anywhere else.
 * - No dynamic code: no eval/new Function, no innerHTML, no remote scripts,
 *   no Node/Electron APIs, no cookies, no clipboard, no file access.
 * - Read data: account balance, balance details, transaction history (read-only
 *   MCP tools). Written data: none — the plugin never mutates the account.
 * - Secret handling: the token stays in memory/localStorage, is sent only to the
 *   configured endpoint, shown only in a password input, and never logged.
 *
 * HOW TO AUDIT QUICKLY
 * 1. Search for `fetch(` in code (skip comment lines) — exactly one call, inside
 *    mcpCall().
 * 2. Search for `localStorage` in code — only the settings/position read/write
 *    helpers.
 * 3. Search for `eval`, `Function(`, `innerHTML`, `document.write`, `import(` in
 *    code — there must be no matches.
 * 4. Search for `http` in code — only the default endpoint constant.
 * 5. Every region starts with a `//#region` line and every function carries a
 *    comment stating its inputs, outputs, and side effects.
 */
window.__ModuleLoader__.load({
	id: "dsh-polza-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		// Configuration model. Values come from the Loader `config` and are then
		// overridden by localStorage. The token is the only secret in this plugin.
		//#region settings
		// Default MCP endpoint; overridable in settings. The widget never calls
		// any other host.
		const DEFAULT_ENDPOINT = "https://polza.ai/api/mcp";
		// Poll interval fallback in seconds; the UI enforces a 15 s minimum.
		const DEFAULT_REFRESH_SECONDS = 60;
		// Full transaction-history rescan cadence; between rescans only page 1 is read.
		const FULL_RESCAN_MS = 5 * 60 * 1000;
		// localStorage keys — the only two places this plugin persists anything.
		const STORAGE_KEY = "dsh-polza-balance:settings";
		const POS_STORAGE_KEY = "dsh-polza-balance:position";

		// Parse a finite number or return the fallback; used for untrusted config/UI
		// values.
		function num(value, fallback) {
			const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
			return Number.isFinite(parsed) ? parsed : fallback;
		}

		// Trimmed non-empty string, or the fallback.
		function str(value, fallback) {
			const parsed = typeof value === "string" ? value.trim() : "";
			return parsed.length > 0 ? parsed : fallback;
		}

		// Validate/coerce a raw settings object (Loader config or localStorage) onto a
		// trusted base. Unknown fields are dropped; the interval is clamped to >= 15 s.
		function sanitize(raw, base) {
			const next = Object.assign({}, base);
			if (!raw || typeof raw !== "object") return next;
			next.token = typeof raw.token === "string" ? raw.token.trim() : next.token;
			next.endpoint = str(raw.endpoint, next.endpoint);
			next.refreshSeconds = Math.max(15, num(raw.refreshSeconds, next.refreshSeconds));
			next.alwaysShowReserved = raw.alwaysShowReserved === true;
			next.alwaysShowFullBalance = raw.alwaysShowFullBalance === true;
			return next;
		}

		// Effective settings: Loader config first, localStorage overrides it. No I/O
		// besides the localStorage read.
		function resolveSettings(config) {
			const base = sanitize(config, {
				token: "",
				endpoint: DEFAULT_ENDPOINT,
				refreshSeconds: DEFAULT_REFRESH_SECONDS,
				alwaysShowReserved: false,
				alwaysShowFullBalance: false,
			});
			let stored = null;
			try {
				stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
			} catch {
				stored = null;
			}
			return sanitize(stored, base);
		}

		/**
		 * The reserve row is shown while a hold exists, or permanently when the
		 * setting asks for it (then a zero reserve still shows as 0,00 ₽).
		 */
		function shouldShowReserved(settings, reserved) {
			if (settings && settings.alwaysShowReserved === true) return true;
			// Hidden unless the user forced it or a hold actually exists.
			return reserved !== null && reserved > 0;
		}

		/**
		 * The full-balance row is tied to the reserve: it appears exactly when the
		 * reserved row does (reserve > 0, or when that row is forced permanently),
		 * so the pair never shows up alone. The setting can also keep it always.
		 */
		function shouldShowFullBalance(settings, reserved) {
			if (settings && settings.alwaysShowFullBalance === true) return true;
			// Follows the reserved row, so the two never appear alone.
			return shouldShowReserved(settings, reserved);
		}

		// Persist settings to localStorage; a failure is non-fatal (the in-memory value
		// still applies).
		function saveSettings(settings) {
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
			} catch {
			// localStorage can be unavailable; the in-memory value still applies.
			}
		}
		//#endregion

		// All network I/O of this plugin lives in this region. Only three read-only
		// MCP tools are used: get_balance, get_balance_details, get_transaction_history.
		//#region polza.ai MCP
		// Extract the JSON payload from an MCP tools/call result (first text block).
		// Returns null when the shape is unexpected; never evaluates anything.
		function mcpText(payload) {
			const block = payload && payload.result && payload.result.content && payload.result.content[0];
			if (!block || block.type !== "text") return null;
			try {
				return JSON.parse(block.text);
			} catch {
				return block.text;
			}
		}

		// THE ONLY NETWORK REQUEST in this bundle: POST JSON-RPC `tools/call` to
		// settings.endpoint, authenticated with the user's token. No other URLs are
		// contacted. Throws on transport/HTTP/MCP errors; callers decide how to degrade.
		async function mcpCall(settings, tool, args) {
			const response = await fetch(settings.endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					Authorization: "Bearer " + settings.token,
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: tool, arguments: args || {} },
				}),
			});
			if (!response.ok) throw new Error("polza.ai: HTTP " + response.status);
			const payload = await response.json();
			if (payload && payload.error) throw new Error(payload.error.message || "polza.ai: ошибка MCP");
			return mcpText(payload);
		}

		// Parse a numeric API field, or null when it is missing/unparseable.
		function toNumber(value) {
			const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
			return Number.isFinite(parsed) ? parsed : null;
		}

		// Local midnight in ms — the boundary of the daily spend figure.
		function localDayStart() {
			const now = new Date();
			now.setHours(0, 0, 0, 0);
			return now.getTime();
		}

		// Stable YYYY-M-D key used to detect a date change between refreshes.
		function dayKeyOf(timestamp) {
			const date = new Date(timestamp);
			return date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate();
		}

		/** Full scan of the history pages for debits since local midnight. */
		async function scanSpentToday(settings) {
			const start = localDayStart();
			const dayKey = dayKeyOf(Date.now());
			let sum = 0;
			let maxId = 0;
			let page = 1;
			// Page through history (max 20 pages) until rows older than local midnight
			// or an empty page is reached.
			for (let guard = 0; guard < 20; guard += 1) {
				const data = await mcpCall(settings, "get_transaction_history", { page, limit: 50 });
				const rows = (data && data.transactions) || [];
				if (rows.length === 0) break;
				let sawOlder = false;
				for (const row of rows) {
					const id = Number(row.id) || 0;
					if (id > maxId) maxId = id;
					const at = Date.parse(row.createdAt);
					if (!Number.isFinite(at)) continue;
					if (at < start) {
						sawOlder = true;
						continue;
					}
					// Only debits count as spending; credits/top-ups do not reduce the total.
					if (row.type === "debit") sum += Math.abs(toNumber(row.amount) || 0);
				}
				if (sawOlder || rows.length < 50) break;
				page += 1;
			}
			return { dayKey, sum, maxId, at: Date.now() };
		}

		/**
		 * Cheap refresh: one page for debits added since the last scan, plus a
		 * full scan after midnight or every few minutes (a busy minute can push
		 * more than one page of new transactions).
		 */
		async function updateSpentToday(settings, previous) {
			const dayKey = dayKeyOf(Date.now());
			const stale = !previous || previous.dayKey !== dayKey || Date.now() - previous.at > FULL_RESCAN_MS;
			// Full rescan on first run, after midnight, or every 5 minutes; otherwise the
			// cheap single-page path below is enough.
			if (stale) return scanSpentToday(settings);
			const data = await mcpCall(settings, "get_transaction_history", { page: 1, limit: 50 });
			const rows = (data && data.transactions) || [];
			let added = 0;
			let maxId = previous.maxId;
			for (const row of rows) {
				const id = Number(row.id) || 0;
				// Cheap path: only rows newer than the last seen id are added.
				if (id <= previous.maxId) continue;
				if (id > maxId) maxId = id;
				if (row.type === "debit") added += Math.abs(toNumber(row.amount) || 0);
			}
			return { dayKey, sum: previous.sum + added, maxId, at: Date.now() };
		}

		// Reserved (held) amount: get_balance wins, get_balance_details is fallback.
		function reservedOf(balance, details) {
			const fromBalance = toNumber(balance && balance.reservedAmount);
			if (fromBalance !== null) return fromBalance;
			return toNumber(details && details.balance && details.balance.reservedAmount);
		}

		// One refresh: balance + details in parallel, then the spend history.
		// Details/history failures degrade gracefully (the balance is still shown).
		async function readBalance(settings, previousSpend) {
			const [balance, details] = await Promise.all([
				mcpCall(settings, "get_balance", {}),
				mcpCall(settings, "get_balance_details", {}).catch(() => null),
			]);
			let spend = previousSpend || null;
			try {
				spend = await updateSpentToday(settings, previousSpend);
			} catch {
			// Keep the last known spend figure when the history read fails.
			}
			const available =
				toNumber(balance && balance.available) ?? toNumber(details && details.balance && details.balance.available);
			const amount = toNumber(balance && balance.balance) ?? toNumber(details && details.balance && details.balance.amount);
			const spentTotal = toNumber(details && details.balance && details.balance.spentAmount);
			return {
				balance: amount,
				available,
				reserved: reservedOf(balance, details),
				spentTotal,
				spentToday: spend ? spend.sum : null,
				spendState: spend,
			};
		}
		//#endregion

		// Pure formatting/theme helpers: no I/O, no state, no side effects.
		//#region formatting and theme
		// Russian money with a Swiss-style thousands separator: 1236.36 -> "1'236,36".
		// Money is printed as 1'236,36 ₽ (apostrophe thousands, comma decimals).
		const THOUSANDS_SEPARATOR = "'";
		const DECIMAL_SEPARATOR = ",";
		const FRACTION_DIGITS = 2;

		// Insert the thousands separator into a digit string.
		function groupThousands(digits) {
			let grouped = "";
			for (let index = 0; index < digits.length; index += 1) {
				const remaining = digits.length - index;
				grouped += digits[index];
				if (remaining > 1 && (remaining - 1) % 3 === 0) grouped += THOUSANDS_SEPARATOR;
			}
			return grouped;
		}

		// Format a number as money without currency; missing values become "—".
		function money(value) {
			const parsed = toNumber(value);
			if (parsed === null) return "—";
			const sign = parsed < 0 ? "-" : "";
			const [whole, fraction] = Math.abs(parsed).toFixed(FRACTION_DIGITS).split(".");
			return sign + groupThousands(whole) + DECIMAL_SEPARATOR + fraction;
		}

		// Money with the ₽ suffix; a missing value stays "—".
		function rub(value) {
			const text = money(value);
			return text === "—" ? "—" : text + " ₽";
		}

		// HH:MM:SS for the tooltip.
		function timeText(timestamp) {
			if (!timestamp) return "";
			return new Date(timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
		}

		// Theme detection: the DSH data attribute first, OS preference as fallback.
		function readDark() {
			const marker = document.body && document.body.getAttribute("data-ds-dark-theme");
			if (marker === "true" || marker === "") return true;
			if (marker === "false") return false;
			return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
		}

		// React hook: re-render on theme changes (attribute mutation + media query).
		function useDark() {
			const [dark, setDark] = React.useState(readDark);
			React.useEffect(() => {
				const update = () => setDark(readDark());
				update();
				const observer = new MutationObserver(update);
				if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
				const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
				if (media && media.addEventListener) media.addEventListener("change", update);
				return () => {
					observer.disconnect();
					if (media && media.removeEventListener) media.removeEventListener("change", update);
				};
			}, []);
			return dark;
		}
		//#endregion

		// Widget placement helpers. The position is persisted in localStorage; no
		// layout is read from the network or from other plugins.
		//#region position
		// Read the saved {left, top}; null when absent or corrupt.
		function readPos() {
			try {
				const raw = JSON.parse(window.localStorage.getItem(POS_STORAGE_KEY) || "null");
				if (raw && Number.isFinite(raw.left) && Number.isFinite(raw.top)) return { left: raw.left, top: raw.top };
			} catch {
			// fall through to the default placement
			}
			return null;
		}

		// Persist the position; failure only loses persistence, not the widget.
		function writePos(pos) {
			try {
				window.localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(pos));
			} catch {
			// the position simply will not survive a reload
			}
		}

		// Current viewport size with safe fallbacks.
		function viewport() {
			return {
				width: window.innerWidth || 1280,
				height: window.innerHeight || 800,
			};
		}

		// Keep the card fully on screen with an 8 px margin.
		function clampPos(pos, size) {
			const vp = viewport();
			const width = size && size.width ? size.width : 208;
			const height = size && size.height ? size.height : 110;
			return {
				left: Math.max(8, Math.min(pos.left, vp.width - width - 8)),
				top: Math.max(8, Math.min(pos.top, vp.height - height - 8)),
			};
		}

		/** Top edge of the sidebar's profile/sign-in button, or null when it is not on screen. */
		function accountAnchorTop() {
			try {
				const height = window.innerHeight || 800;
				let best = null;
				// DSH marks the sidebar profile/sign-in button with [data-signed-out];
				// the widget starts right above it when it is on screen.
				const nodes = document.querySelectorAll("[data-signed-out]");
				for (const node of nodes) {
					const rect = node.getBoundingClientRect();
					if (rect.width < 20 || rect.height < 18 || rect.height > 96) continue;
					if (rect.left > 380) continue;
					if (rect.top < height * 0.5) continue;
					if (best === null || rect.top < best) best = rect.top;
				}
				return best;
			} catch {
				return null;
			}
		}
		//#endregion

		// Rendering layer: one overlay card, one settings panel, no other DOM. All
		// handlers below only update local state or call the two functions above.
		//#region widget
		// Theme colours. Plain literals — nothing is fetched or loaded at runtime.
		function palette(dark) {
			if (dark) {
				return {
					card: "rgba(32, 32, 36, 0.92)",
					border: "rgba(255, 255, 255, 0.14)",
					text: "#f4f4f5",
					muted: "#a1a1aa",
					track: "rgba(255, 255, 255, 0.14)",
					accent: "#60a5fa",
					danger: "#f87171",
					panel: "rgba(24, 24, 28, 0.98)",
					input: "rgba(255, 255, 255, 0.06)",
					shadow: "0 8px 28px rgba(0, 0, 0, 0.45)",
				};
			}
			return {
				card: "rgba(255, 255, 255, 0.94)",
				border: "rgba(15, 23, 42, 0.10)",
				text: "#18181b",
				muted: "#6b7280",
				track: "rgba(15, 23, 42, 0.10)",
				accent: "#2563eb",
				danger: "#dc2626",
				panel: "rgba(255, 255, 255, 0.99)",
				input: "rgba(15, 23, 42, 0.04)",
				shadow: "0 8px 28px rgba(15, 23, 42, 0.14)",
			};
		}

		// System font stack (no web fonts, therefore no external requests).
		const fontStack =
			'-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif';

		// Poll indicator: green = fresh, yellow = loading, red = error.
		function statusColor(state) {
			if (state.status === "error") return "#ef4444";
			if (state.status === "loading") return "#eab308";
			return "#22c55e";
		}

		// Small uppercase caption used by every card row.
		function Label(props) {
			return h(
				"span",
				{ style: { fontSize: 10.5, letterSpacing: "0.04em", color: props.color, textTransform: "uppercase" } },
				props.children,
			);
		}

		// Shared style for the two header icon buttons.
		function iconButtonStyle(colors, active) {
			return {
				font: "inherit",
				fontSize: 12,
				lineHeight: 1,
				padding: "2px 4px",
				border: "none",
				borderRadius: 6,
				background: active ? colors.input : "transparent",
				color: active ? colors.text : colors.muted,
				cursor: "pointer",
			};
		}

		// Settings panel: renders a draft copy only; Save hands it to onSave.
		// Fields: token (password), refresh interval, two visibility checkboxes.
		function SettingsPanel(props) {
			const { colors, draft, setDraft, onSave, onRefresh, onClose, busy } = props;
			const inputStyle = {
				width: "100%",
				boxSizing: "border-box",
				font: "inherit",
				fontSize: 12,
				padding: "5px 7px",
				borderRadius: 7,
				border: "1px solid " + colors.border,
				background: colors.input,
				color: colors.text,
				outline: "none",
			};
			const fieldStyle = { display: "flex", flexDirection: "column", gap: 3 };
			const labelStyle = { fontSize: 10.5, color: colors.muted };
			const buttonStyle = {
				font: "inherit",
				fontSize: 11.5,
				padding: "5px 10px",
				borderRadius: 7,
				border: "1px solid " + colors.border,
				background: colors.input,
				color: colors.text,
				cursor: "pointer",
			};
			// Panel container: opens above the card; clicks inside never reach the card.
			return h(
				"div",
				{
					style: {
						position: "absolute",
						bottom: "calc(100% + 8px)",
						left: 0,
						width: 268,
						boxSizing: "border-box",
						padding: 12,
						display: "flex",
						flexDirection: "column",
						gap: 9,
						borderRadius: 12,
						border: "1px solid " + colors.border,
						background: colors.panel,
						boxShadow: colors.shadow,
						color: colors.text,
						fontFamily: fontStack,
						fontSize: 12,
						zIndex: 1,
					},
					onClick: (event) => event.stopPropagation(),
				},
				// Header: title and close button.
				h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } }, [
					h("strong", { key: "title", style: { fontSize: 12.5 } }, "polza.ai"),
					h(
						"button",
						{
							// Close without saving.
							key: "close",
							type: "button",
							onClick: onClose,
							title: "Закрыть",
							style: Object.assign({}, buttonStyle, { padding: "1px 7px", border: "none", background: "transparent", color: colors.muted }),
						},
						"✕",
					),
				]),
				h("label", { style: fieldStyle }, [
					// Token field (password input; the value is never rendered as text).
					h("span", { key: "l", style: labelStyle }, "Токен polza.ai"),
					h("input", {
						key: "i",
						type: "password",
						value: draft.token,
						placeholder: "polza_…",
						style: inputStyle,
						onChange: (event) => setDraft(Object.assign({}, draft, { token: event.target.value })),
					}),
				]),
				h("label", { style: fieldStyle }, [
					// Refresh interval in seconds; sanitize() clamps it to >= 15.
					h("span", { key: "l", style: labelStyle }, "Обновление, сек"),
					h("input", {
						key: "i",
						type: "number",
						min: 15,
						step: 5,
						value: draft.refreshSeconds,
						style: inputStyle,
						onChange: (event) => setDraft(Object.assign({}, draft, { refreshSeconds: event.target.value })),
					}),
				]),
				h(
					"label",
					{
						style: { display: "flex", alignItems: "flex-start", gap: 7, cursor: "pointer", lineHeight: 1.35 },
						// Checkbox: always show the full-balance row.
						title: "Показывать строку «Полный баланс» всегда, а не только вместе с «Зарезервировано»",
					},
					[
						h("input", {
							key: "check",
							type: "checkbox",
							checked: draft.alwaysShowFullBalance === true,
							style: { margin: "2px 0 0", accentColor: colors.accent, cursor: "pointer" },
							onChange: (event) =>
								setDraft(Object.assign({}, draft, { alwaysShowFullBalance: event.target.checked === true })),
						}),
						h("span", { key: "text", style: { fontSize: 11.5, color: colors.text } }, [
							"Всегда показывать «Полный баланс»",
							h(
								"span",
								{ key: "hint", style: { display: "block", fontSize: 10, color: colors.muted, marginTop: 1 } },
								"Без галки строка появляется вместе с «Зарезервировано», когда резерв > 0.",
							),
						]),
					],
				),
				h(
					"label",
					{
						style: { display: "flex", alignItems: "flex-start", gap: 7, cursor: "pointer", lineHeight: 1.35 },
						// Checkbox: always show the reserved row.
						title: "Показывать строку «Зарезервировано» всегда, даже когда резерв равен нулю",
					},
					[
						h("input", {
							key: "check",
							type: "checkbox",
							checked: draft.alwaysShowReserved === true,
							style: { margin: "2px 0 0", accentColor: colors.accent, cursor: "pointer" },
							onChange: (event) =>
								setDraft(Object.assign({}, draft, { alwaysShowReserved: event.target.checked === true })),
						}),
						h("span", { key: "text", style: { fontSize: 11.5, color: colors.text } }, [
							"Всегда показывать «Зарезервировано»",
							h(
								"span",
								{ key: "hint", style: { display: "block", fontSize: 10, color: colors.muted, marginTop: 1 } },
								"Без галки строка появляется, когда резерв > 0 — в том числе после отправки запроса.",
							),
						]),
					],
				),
				// Actions: save (persists + refreshes) and refresh-now.
				h("div", { style: { display: "flex", gap: 8, marginTop: 2 } }, [
					h(
						"button",
						{
							key: "save",
							type: "button",
							onClick: onSave,
							style: Object.assign({}, buttonStyle, {
								flex: 1,
								background: colors.accent,
								borderColor: colors.accent,
								color: "#ffffff",
								fontWeight: 600,
							}),
						},
						"Сохранить",
					),
					h("button", { key: "refresh", type: "button", onClick: onRefresh, style: buttonStyle }, busy ? "…" : "Обновить"),
				]),
				h(
					"div",
					{ style: { fontSize: 10, color: colors.muted, lineHeight: 1.35 } },
					// Footnote: where the data comes from and what is stored locally.
					"Данные читаются из MCP polza.ai; настройки и позиция хранятся локально в браузере.",
				),
			);
		}

		// The overlay widget: owns the refresh timer, the drag position, the settings
		// draft, and the last fetched balance snapshot.
		function PolzaBalanceWidget(props) {
			const colors = palette(useDark());
			const initial = props && props.initialSettings ? props.initialSettings : resolveSettings(null);
			// Refs mirror state for callbacks/timers without re-subscribing them.
			const settingsRef = React.useRef(initial);
			const spendRef = React.useRef(null);
			const cardRef = React.useRef(null);
			const dragRef = React.useRef(null);
			const posRef = React.useRef(null);
			const placedRef = React.useRef(false);
			const [settings, setSettings] = React.useState(initial);
			const [draft, setDraft] = React.useState(initial);
			const [panelOpen, setPanelOpen] = React.useState(false);
			const [dragging, setDragging] = React.useState(false);
			// Initial position: the saved one, else above the sidebar profile button.
			const [pos, setPos] = React.useState(() => {
				const saved = readPos();
				if (saved) return clampPos(saved);
				const height = 110;
				const anchor = accountAnchorTop();
				const top = anchor !== null ? anchor - height - 10 : (window.innerHeight || 800) - 96 - height;
				return clampPos({ left: 16, top });
			});
			// Latest fetch result; status drives the indicator dot and tooltip.
			const [state, setState] = React.useState({ status: "loading", data: null, error: null, updatedAt: null });
			const [busy, setBusy] = React.useState(false);
			const alive = React.useRef(true);

			// Measured card size, used for clamping while dragging and on resize.
			const cardSize = () => {
				const card = cardRef.current;
				if (!card) return { width: 208, height: 110 };
				const rect = card.getBoundingClientRect();
				return { width: rect.width || 208, height: rect.height || 110 };
			};

			// Keep the ref in sync so refresh() always reads current settings.
			React.useEffect(() => {
				settingsRef.current = settings;
			}, [settings]);

			// Keep the ref in sync for the drag handlers.
			React.useEffect(() => {
				posRef.current = pos;
			}, [pos]);

			// First placement only: saved position or the anchor computed above.
			// Keep the widget clear of the profile/sign-in button on first placement.
			React.useLayoutEffect(() => {
				if (placedRef.current) return;
				placedRef.current = true;
				if (readPos()) {
					setPos(clampPos(readPos(), cardSize()));
					return;
				}
				const anchor = accountAnchorTop();
				const size = cardSize();
				const top = anchor !== null ? anchor - size.height - 10 : (window.innerHeight || 800) - 96 - size.height;
				setPos(clampPos({ left: 16, top }, size));
			}, []);

			React.useEffect(() => {
				// Re-clamp when the viewport changes.
				const onResize = () => setPos((current) => clampPos(current, cardSize()));
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);

			// Fetch one snapshot. readBalance() is the only network path; the result
			// replaces the card state, errors keep the previous data with an error dot.
			const refresh = React.useCallback(async () => {
				const current = settingsRef.current;
				if (!current.token) {
					setState({ status: "error", data: null, error: "Токен не задан", updatedAt: Date.now() });
					return;
				}
				setBusy(true);
				setState((previous) => Object.assign({}, previous, { status: previous.data ? previous.status : "loading" }));
				try {
					const data = await readBalance(current, spendRef.current);
					spendRef.current = data.spendState;
					if (alive.current) setState({ status: "ok", data, error: null, updatedAt: Date.now() });
				} catch (error) {
					const message = String((error && error.message) || error);
					if (alive.current) {
						setState((previous) => ({
							status: "error",
							data: previous.data,
							error: message,
							updatedAt: Date.now(),
						}));
					}
				} finally {
					if (alive.current) setBusy(false);
				}
			}, []);

			React.useEffect(() => {
				alive.current = true;
				refresh();
			// Auto refresh: the configured interval, plus an immediate read when the tab
				// becomes visible again.
				const timer = window.setInterval(refresh, Math.max(15, settings.refreshSeconds) * 1000);
				const onVisible = () => {
					if (document.visibilityState === "visible") refresh();
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					alive.current = false;
					window.clearInterval(timer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [refresh, settings.refreshSeconds]);

			// Third refresh trigger: a request the user just sent (two delayed reads
			// catch the reserve hold that appears a moment later).
			// Third refresh trigger: the Host reports Session running status, so a
			// message the user just sent refreshes the card at once; two follow-up
			// reads catch the hold that is created a moment later.
			React.useEffect(() => {
				if (!props || typeof props.subscribeActivity !== "function") return undefined;
				const timers = [];
				const dispose = props.subscribeActivity((running) => {
					refresh();
					if (running) {
						timers.push(window.setTimeout(refresh, 2500));
						timers.push(window.setTimeout(refresh, 7000));
					}
				});
				return () => {
					while (timers.length > 0) window.clearTimeout(timers.pop());
					if (typeof dispose === "function") dispose();
				};
			}, [refresh]);

			// --- Drag & drop: pointer events move the fixed-position card. ---
			// --- drag and drop ---
			// Start a drag unless the gesture began on an interactive element.
			const onPointerDown = (event) => {
				if (event.button !== undefined && event.button !== 0) return;
				const target = event.target;
				if (target && target.closest && target.closest("button, input, textarea, select, a, label")) return;
				const card = cardRef.current;
				if (!card) return;
				const rect = card.getBoundingClientRect();
				dragRef.current = {
					pointerId: event.pointerId,
					offsetX: event.clientX - rect.left,
					offsetY: event.clientY - rect.top,
					startLeft: rect.left,
					startTop: rect.top,
					moved: false,
				};
				setDragging(true);
				if (card.setPointerCapture && event.pointerId !== undefined) {
					try {
						card.setPointerCapture(event.pointerId);
					} catch {
					// capture is optional; window moves still land on the card
					}
				}
			};

			// Move the card; a 3 px threshold separates a drag from a click.
			const onPointerMove = (event) => {
				const drag = dragRef.current;
				if (!drag || drag.pointerId !== event.pointerId) return;
				const left = event.clientX - drag.offsetX;
				const top = event.clientY - drag.offsetY;
				if (Math.abs(left - drag.startLeft) > 3 || Math.abs(top - drag.startTop) > 3) drag.moved = true;
				if (drag.moved) {
					const next = clampPos({ left, top }, cardSize());
					posRef.current = next;
					setPos(next);
					event.preventDefault();
				}
			};

			// Finish: persist a moved card, otherwise treat it as click-to-refresh.
			const endDrag = (event) => {
				const drag = dragRef.current;
				if (!drag || (event && drag.pointerId !== event.pointerId)) return;
				dragRef.current = null;
				setDragging(false);
				if (drag.moved) {
					if (posRef.current) writePos(posRef.current);
				} else {
					refresh();
				}
			};

			// Values derived for rendering; all are read-only display data.
			const data = state.data || {};
			const spentToday = toNumber(data.spentToday);
			const reserved = toNumber(data.reserved);
			const reservedPositive = reserved !== null && reserved > 0;
			const showReserved = shouldShowReserved(settings, reserved);
			const showFullBalance = shouldShowFullBalance(settings, reserved);
			const dot = statusColor(state);
			const balanceNote = toNumber(data.balance) === null ? "" : " · на счёте " + rub(data.balance);
			const reservedNote = reservedPositive ? " · в резерве " + rub(reserved) : "";
			const title =
				state.status === "error"
					? (state.error || "Ошибка") + balanceNote
					: "Обновлено " + timeText(state.updatedAt) + balanceNote + reservedNote + " · клик — обновить, перетащите — переместить";

			// Open the settings panel with a draft copy of the current settings.
			const openPanel = (event) => {
				if (event) {
					event.stopPropagation();
					event.preventDefault();
				}
				setDraft(settings);
				setPanelOpen(true);
			};

			// Save: validate the draft, persist it, drop cached spend, refresh.
			const save = () => {
				const next = sanitize(draft, settings);
				setSettings(next);
				settingsRef.current = next;
				saveSettings(next);
				setDraft(next);
				spendRef.current = null;
				setPanelOpen(false);
				refresh();
			};

			// Card root: the visible widget (positioned by the fixed wrapper below).
			const card = h(
				"div",
				{
					ref: cardRef,
					onPointerDown,
					onPointerMove,
					onPointerUp: endDrag,
					onPointerCancel: endDrag,
					onDoubleClick: openPanel,
					title,
					style: {
						position: "relative",
						width: 208,
						boxSizing: "border-box",
						padding: "9px 11px 10px",
						display: "flex",
						flexDirection: "column",
						gap: 5,
						borderRadius: 12,
						border: "1px solid " + colors.border,
						background: colors.card,
						backdropFilter: "blur(10px)",
						WebkitBackdropFilter: "blur(10px)",
						boxShadow: colors.shadow,
						color: colors.text,
						fontFamily: fontStack,
						cursor: dragging ? "grabbing" : "grab",
						userSelect: "none",
						touchAction: "none",
						transition: dragging ? "none" : "box-shadow 160ms ease",
					},
				},
				// Header row: status dot, product label, refresh and settings buttons.
				h("div", { style: { display: "flex", alignItems: "center", gap: 6 } }, [
					// Status dot: green fresh / yellow loading / red error.
					h("span", {
						key: "dot",
						style: {
							width: 7,
							height: 7,
							borderRadius: "50%",
							background: dot,
							flex: "0 0 auto",
							boxShadow: "0 0 0 3px " + dot + "22",
						},
					}),
					h(Label, { key: "label", color: colors.muted }, "polza.ai"),
					h("span", { key: "spacer", style: { flex: 1 } }),
					h(
						"button",
						{
							// Manual refresh (⟳).
							key: "refresh",
							type: "button",
							onClick: (event) => {
								event.stopPropagation();
								refresh();
							},
							title: "Обновить сейчас",
							"aria-label": "Обновить сейчас",
							style: iconButtonStyle(colors, false),
						},
						busy ? "…" : "⟳",
					),
					h(
						"button",
						{
							// Settings (⚙).
							key: "gear",
							type: "button",
							onClick: openPanel,
							title: "Настройки",
							"aria-label": "Настройки",
							style: iconButtonStyle(colors, panelOpen),
						},
						"⚙",
					),
				]),
				// Balance row: the available amount, the number the user acts on.
				h("div", { style: { display: "flex", alignItems: "baseline", gap: 6 } }, [
					h(Label, { key: "label", color: colors.muted }, "Баланс"),
					h("span", { key: "spacer", style: { flex: 1 } }),
					h(
						"span",
						{
							key: "value",
							style: { fontSize: 15, fontWeight: 650, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" },
						},
						rub(data.available),
					),
				]),
				// Full balance row: visible when the reserved row shows or the setting forces
				// it; the amount is blue (theme accent).
				showFullBalance
					? h("div", { style: { display: "flex", alignItems: "baseline", gap: 6, fontSize: 10.5, color: colors.muted } }, [
							h("span", { key: "label" }, "Полный баланс"),
							h("span", { key: "spacer", style: { flex: 1 } }),
							h(
								"span",
								{
									key: "value",
									style: {
										fontVariantNumeric: "tabular-nums",
										textAlign: "right",
										whiteSpace: "nowrap",
										color: colors.accent,
									},
								},
								rub(data.balance),
							),
						])
					: null,
				// Reserved row: the hold under running generations; red when > 0.
				showReserved
					? h("div", { style: { display: "flex", alignItems: "baseline", gap: 6, fontSize: 10.5, color: colors.muted } }, [
							h("span", { key: "label" }, "Зарезервировано"),
							h("span", { key: "spacer", style: { flex: 1 } }),
							h(
								"span",
								{
									key: "value",
									style: {
										fontVariantNumeric: "tabular-nums",
										textAlign: "right",
										whiteSpace: "nowrap",
										color: reservedPositive ? colors.danger : colors.muted,
										fontWeight: reservedPositive ? 600 : 400,
									},
								},
								rub(reserved),
							),
						])
					: null,
				// Spent today: sum of debits since local midnight.
				h("div", { style: { display: "flex", alignItems: "baseline", gap: 6, fontSize: 10.5, color: colors.muted } }, [
					h("span", { key: "label" }, "Потрачено за сутки"),
					h("span", { key: "spacer", style: { flex: 1 } }),
					h(
						"span",
						{ key: "value", style: { fontVariantNumeric: "tabular-nums", textAlign: "right", whiteSpace: "nowrap" } },
						rub(spentToday),
					),
				]),
				// Lifetime spend reported by get_balance_details.
				h("div", { style: { display: "flex", alignItems: "baseline", gap: 6, fontSize: 10.5, color: colors.muted } }, [
					h("span", { key: "label" }, "Всего потрачено"),
					h("span", { key: "spacer", style: { flex: 1 } }),
					h(
						"span",
						{ key: "value", style: { fontVariantNumeric: "tabular-nums", textAlign: "right", whiteSpace: "nowrap" } },
						rub(data.spentTotal),
					),
				]),
			);

			// Fixed-position wrapper: the card plus the settings panel above it.
			return h(
				"div",
				{
					style: {
						position: "fixed",
						left: pos.left,
						top: pos.top,
						zIndex: 40,
						fontFamily: fontStack,
					},
				},
				// The settings panel is rendered only while it is open.
				panelOpen
					? h(SettingsPanel, {
							colors,
							draft,
							setDraft,
							onSave: save,
							onRefresh: () => {
								setPanelOpen(false);
								refresh();
							},
							onClose: () => setPanelOpen(false),
							busy,
						})
					: null,
				card,
			);
		}
		//#endregion

		// Host capabilities used by this bundle: slot registration and the remote
		// event bus (session running status). Nothing else is requested.
		const inject = ["slots", "remote"];

		// Register the widget in the shell overlay and forward session activity.
		function apply(ctx, config) {
			const settings = resolveSettings(config);

			// Third refresh trigger: the Host reports every Session's running
			// status, so a request the user just sent refreshes the widget at
			// once instead of waiting for the next timer tick.
			// Activity fan-out: one Host subscription, many widget listeners.
			const activityListeners = new Set();
			const notifyActivity = (running) => {
				for (const listener of [...activityListeners]) {
					try {
						listener(running === true);
					} catch {
					// one widget listener must not break the Host event bus
					}
				}
			};
			const subscribeActivity = (listener) => {
				activityListeners.add(listener);
				return () => {
					activityListeners.delete(listener);
				};
			};
			// The Host reports per-session running status; forward it to the widget.
			if (ctx.remote && typeof ctx.remote.$on === "function") {
				ctx.effect(() => {
					const off = ctx.remote.$on("api-session/status", (_sessionId, running) => notifyActivity(running));
					return () => {
						activityListeners.clear();
						if (typeof off === "function") off();
					};
				}, "polza-balance:activity");
			}

			// Mount the widget into the Web shell's overlay slot.
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "polza-balance",
					},
					() => h(PolzaBalanceWidget, { initialSettings: settings, subscribeActivity }),
				),
			);
		}

		// Public module surface for the Host loader and the smoke test.
		exports.PolzaBalanceWidget = PolzaBalanceWidget;
		exports.apply = apply;
		exports.inject = inject;
		// Exposed for smoke tests only; the widget reads nothing from here.
		exports.__internals = {
			mcpCall,
			readBalance,
			reservedOf,
			scanSpentToday,
			updateSpentToday,
			sanitize,
			resolveSettings,
			shouldShowReserved,
			shouldShowFullBalance,
			money,
			rub,
			paletteColors: palette,
			clampPos,
			accountAnchorTop,
			readPos,
			writePos,
		};
		return module.exports;
	},
});
