window.__ModuleLoader__.load({
	id: "dsh-polza-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		//#region settings
		const DEFAULT_ENDPOINT = "https://polza.ai/api/mcp";
		const DEFAULT_REFRESH_SECONDS = 60;
		const FULL_RESCAN_MS = 5 * 60 * 1000;
		const STORAGE_KEY = "dsh-polza-balance:settings";
		const POS_STORAGE_KEY = "dsh-polza-balance:position";

		function num(value, fallback) {
			const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
			return Number.isFinite(parsed) ? parsed : fallback;
		}

		function str(value, fallback) {
			const parsed = typeof value === "string" ? value.trim() : "";
			return parsed.length > 0 ? parsed : fallback;
		}

		function sanitize(raw, base) {
			const next = Object.assign({}, base);
			if (!raw || typeof raw !== "object") return next;
			next.token = typeof raw.token === "string" ? raw.token.trim() : next.token;
			next.endpoint = str(raw.endpoint, next.endpoint);
			next.refreshSeconds = Math.max(15, num(raw.refreshSeconds, next.refreshSeconds));
			return next;
		}

		function resolveSettings(config) {
			const base = sanitize(config, {
				token: "",
				endpoint: DEFAULT_ENDPOINT,
				refreshSeconds: DEFAULT_REFRESH_SECONDS,
			});
			let stored = null;
			try {
				stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
			} catch {
				stored = null;
			}
			return sanitize(stored, base);
		}

		function saveSettings(settings) {
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
			} catch {
				// localStorage can be unavailable; the in-memory value still applies.
			}
		}
		//#endregion

		//#region polza.ai MCP
		function mcpText(payload) {
			const block = payload && payload.result && payload.result.content && payload.result.content[0];
			if (!block || block.type !== "text") return null;
			try {
				return JSON.parse(block.text);
			} catch {
				return block.text;
			}
		}

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

		function toNumber(value) {
			const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
			return Number.isFinite(parsed) ? parsed : null;
		}

		function localDayStart() {
			const now = new Date();
			now.setHours(0, 0, 0, 0);
			return now.getTime();
		}

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
			if (stale) return scanSpentToday(settings);
			const data = await mcpCall(settings, "get_transaction_history", { page: 1, limit: 50 });
			const rows = (data && data.transactions) || [];
			let added = 0;
			let maxId = previous.maxId;
			for (const row of rows) {
				const id = Number(row.id) || 0;
				if (id <= previous.maxId) continue;
				if (id > maxId) maxId = id;
				if (row.type === "debit") added += Math.abs(toNumber(row.amount) || 0);
			}
			return { dayKey, sum: previous.sum + added, maxId, at: Date.now() };
		}

		function reservedOf(balance, details) {
			const fromBalance = toNumber(balance && balance.reservedAmount);
			if (fromBalance !== null) return fromBalance;
			return toNumber(details && details.balance && details.balance.reservedAmount);
		}

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

		//#region formatting and theme
		// Russian money with a Swiss-style thousands separator: 1236.36 -> "1'236,36".
		const THOUSANDS_SEPARATOR = "'";
		const DECIMAL_SEPARATOR = ",";
		const FRACTION_DIGITS = 2;

		function groupThousands(digits) {
			let grouped = "";
			for (let index = 0; index < digits.length; index += 1) {
				const remaining = digits.length - index;
				grouped += digits[index];
				if (remaining > 1 && (remaining - 1) % 3 === 0) grouped += THOUSANDS_SEPARATOR;
			}
			return grouped;
		}

		function money(value) {
			const parsed = toNumber(value);
			if (parsed === null) return "—";
			const sign = parsed < 0 ? "-" : "";
			const [whole, fraction] = Math.abs(parsed).toFixed(FRACTION_DIGITS).split(".");
			return sign + groupThousands(whole) + DECIMAL_SEPARATOR + fraction;
		}

		function rub(value) {
			const text = money(value);
			return text === "—" ? "—" : text + " ₽";
		}

		function timeText(timestamp) {
			if (!timestamp) return "";
			return new Date(timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
		}

		function readDark() {
			const marker = document.body && document.body.getAttribute("data-ds-dark-theme");
			if (marker === "true" || marker === "") return true;
			if (marker === "false") return false;
			return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
		}

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

		//#region position
		function readPos() {
			try {
				const raw = JSON.parse(window.localStorage.getItem(POS_STORAGE_KEY) || "null");
				if (raw && Number.isFinite(raw.left) && Number.isFinite(raw.top)) return { left: raw.left, top: raw.top };
			} catch {
				// fall through to the default placement
			}
			return null;
		}

		function writePos(pos) {
			try {
				window.localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(pos));
			} catch {
				// the position simply will not survive a reload
			}
		}

		function viewport() {
			return {
				width: window.innerWidth || 1280,
				height: window.innerHeight || 800,
			};
		}

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

		//#region widget
		function palette(dark) {
			if (dark) {
				return {
					card: "rgba(32, 32, 36, 0.92)",
					border: "rgba(255, 255, 255, 0.14)",
					text: "#f4f4f5",
					muted: "#a1a1aa",
					track: "rgba(255, 255, 255, 0.14)",
					accent: "#60a5fa",
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
				panel: "rgba(255, 255, 255, 0.99)",
				input: "rgba(15, 23, 42, 0.04)",
				shadow: "0 8px 28px rgba(15, 23, 42, 0.14)",
			};
		}

		const fontStack =
			'-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif';

		function statusColor(state) {
			if (state.status === "error") return "#ef4444";
			if (state.status === "loading") return "#eab308";
			return "#22c55e";
		}

		function Label(props) {
			return h(
				"span",
				{ style: { fontSize: 10.5, letterSpacing: "0.04em", color: props.color, textTransform: "uppercase" } },
				props.children,
			);
		}

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
				h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } }, [
					h("strong", { key: "title", style: { fontSize: 12.5 } }, "polza.ai"),
					h(
						"button",
						{
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
					"Данные читаются из MCP polza.ai; настройки и позиция хранятся локально в браузере.",
				),
			);
		}

		function PolzaBalanceWidget(props) {
			const colors = palette(useDark());
			const initial = props && props.initialSettings ? props.initialSettings : resolveSettings(null);
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
			const [pos, setPos] = React.useState(() => {
				const saved = readPos();
				if (saved) return clampPos(saved);
				const height = 110;
				const anchor = accountAnchorTop();
				const top = anchor !== null ? anchor - height - 10 : (window.innerHeight || 800) - 96 - height;
				return clampPos({ left: 16, top });
			});
			const [state, setState] = React.useState({ status: "loading", data: null, error: null, updatedAt: null });
			const [busy, setBusy] = React.useState(false);
			const alive = React.useRef(true);

			const cardSize = () => {
				const card = cardRef.current;
				if (!card) return { width: 208, height: 110 };
				const rect = card.getBoundingClientRect();
				return { width: rect.width || 208, height: rect.height || 110 };
			};

			React.useEffect(() => {
				settingsRef.current = settings;
			}, [settings]);

			React.useEffect(() => {
				posRef.current = pos;
			}, [pos]);

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
				const onResize = () => setPos((current) => clampPos(current, cardSize()));
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);

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

			// --- drag and drop ---
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

			const data = state.data || {};
			const spentToday = toNumber(data.spentToday);
			const reserved = toNumber(data.reserved);
			const showReserved = reserved !== null && reserved > 0;
			const dot = statusColor(state);
			const balanceNote = toNumber(data.balance) === null ? "" : " · на счёте " + rub(data.balance);
			const reservedNote = showReserved ? " · в резерве " + rub(reserved) : "";
			const title =
				state.status === "error"
					? (state.error || "Ошибка") + balanceNote
					: "Обновлено " + timeText(state.updatedAt) + balanceNote + reservedNote + " · клик — обновить, перетащите — переместить";

			const openPanel = (event) => {
				if (event) {
					event.stopPropagation();
					event.preventDefault();
				}
				setDraft(settings);
				setPanelOpen(true);
			};

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
				h("div", { style: { display: "flex", alignItems: "center", gap: 6 } }, [
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
				h("div", { style: { display: "flex", alignItems: "baseline", gap: 6, fontSize: 10.5, color: colors.muted } }, [
					h("span", { key: "label" }, "Полный баланс"),
					h("span", { key: "spacer", style: { flex: 1 } }),
					h(
						"span",
						{ key: "value", style: { fontVariantNumeric: "tabular-nums", textAlign: "right", whiteSpace: "nowrap" } },
						rub(data.balance),
					),
				]),
				showReserved
					? h("div", { style: { display: "flex", alignItems: "baseline", gap: 6, fontSize: 10.5, color: colors.muted } }, [
							h("span", { key: "label" }, "Зарезервировано"),
							h("span", { key: "spacer", style: { flex: 1 } }),
							h(
								"span",
								{
									key: "value",
									style: { fontVariantNumeric: "tabular-nums", textAlign: "right", whiteSpace: "nowrap" },
								},
								rub(reserved),
							),
						])
					: null,
				h("div", { style: { display: "flex", alignItems: "baseline", gap: 6, fontSize: 10.5, color: colors.muted } }, [
					h("span", { key: "label" }, "Потрачено за сутки"),
					h("span", { key: "spacer", style: { flex: 1 } }),
					h(
						"span",
						{ key: "value", style: { fontVariantNumeric: "tabular-nums", textAlign: "right", whiteSpace: "nowrap" } },
						rub(spentToday),
					),
				]),
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

		const inject = ["slots"];

		function apply(ctx, config) {
			const settings = resolveSettings(config);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "polza-balance",
					},
					() => h(PolzaBalanceWidget, { initialSettings: settings }),
				),
			);
		}

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
			money,
			rub,
			clampPos,
			accountAnchorTop,
			readPos,
			writePos,
		};
		return module.exports;
	},
});
