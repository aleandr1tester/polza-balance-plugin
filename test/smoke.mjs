// Smoke test for the dsh-polza-balance client bundle: executes the module-loader
// factory against a minimal window/fake-React shim, then exercises the real
// polza.ai MCP read path and the incremental spend tracking.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(PLUGIN_ROOT, "lib", "client.js");
const source = fs.readFileSync(bundlePath, "utf8");

const registered = [];
globalThis.window = {
	__ModuleLoader__: { load: (definition) => registered.push(definition) },
	localStorage: {
		store: new Map(),
		getItem(key) {
			return this.store.has(key) ? this.store.get(key) : null;
		},
		setItem(key, value) {
			this.store.set(key, String(value));
		},
	},
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	setInterval: () => 1,
	clearInterval: () => {},
};
globalThis.document = {
	body: { getAttribute: () => null },
	addEventListener() {},
	removeEventListener() {},
	visibilityState: "visible",
};
globalThis.MutationObserver = class {
	observe() {}
	disconnect() {}
};

const fakeReact = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null) }),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useEffect: () => {},
	useLayoutEffect: () => {},
	useRef: (initial) => ({ current: initial }),
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
};
const moduleTable = { react: fakeReact };

new Function("window", source)(globalThis.window);

if (registered.length !== 1) throw new Error(`expected one registration, got ${registered.length}`);
const definition = registered[0];
console.log("registered id:", definition.id);

const mod = definition.factory((specifier) => {
	if (!(specifier in moduleTable)) throw new Error(`unexpected require("${specifier}")`);
	return moduleTable[specifier];
});

console.log("exports:", Object.keys(mod).join(", "));
if (typeof mod.apply !== "function") throw new Error("missing apply");
if (!Array.isArray(mod.inject) || !mod.inject.includes("slots")) throw new Error("missing slots inject");

// --- registration through a fake slot registry ---
const registrations = [];
const ctx = {
	slots: {
		inject(name, factory) {
			console.log("slots.inject:", name);
			return factory();
		},
		register(options, component) {
			registrations.push({ options, component });
			return () => {};
		},
	},
};
mod.apply(ctx, { token: "test-token", refreshSeconds: 60 });
console.log("slot registrations:", registrations.map((r) => r.options.name + "/" + r.options.id).join(", "));

// --- render the component (unwrap function components) ---
let tree = registrations[0].component();
while (tree && typeof tree.type === "function") tree = tree.type(tree.props);
console.log("root tree type:", tree.type, "style.position:", tree.props.style.position);
const card = tree.children.find((child) => child && child.type === "div" && child.props.style && child.props.style.borderRadius === 12);
if (!card) throw new Error("card element not rendered");

// --- money formatting: apostrophe thousands separator, ₽ suffix ---
const fmt = mod.__internals;
const formatCases = [
	[1236.36, "1'236,36"],
	[12, "12,00"],
	[0.5, "0,50"],
	[1234567.891, "1'234'567,89"],
	[999.999, "1'000,00"],
	[-42.5, "-42,50"],
	[null, "—"],
	["113.35", "113,35"],
];
for (const [input, expected] of formatCases) {
	const actual = fmt.money(input);
	if (actual !== expected) throw new Error(`money(${JSON.stringify(input)}) = "${actual}", expected "${expected}"`);
}
if (fmt.rub(1236.36) !== "1'236,36 ₽") throw new Error(`rub() suffix mismatch: ${fmt.rub(1236.36)}`);
if (fmt.rub(null) !== "—") throw new Error(`rub(null) must stay a dash, got "${fmt.rub(null)}"`);
console.log("money format:", formatCases.map(([value]) => fmt.rub(value)).join(" | "));

// --- reserved amount extraction: balance wins, details is the fallback ---
const reservedCases = [
	[{ reservedAmount: "42.78" }, null, 42.78],
	[{}, { balance: { reservedAmount: "1.50" } }, 1.5],
	[{ reservedAmount: "0.00" }, null, 0],
	[null, null, null],
];
for (const [balanceFixture, detailsFixture, expected] of reservedCases) {
	const actual = fmt.reservedOf(balanceFixture, detailsFixture);
	if (actual !== expected) {
		throw new Error(`reservedOf(${JSON.stringify(balanceFixture)}, ${JSON.stringify(detailsFixture)}) = ${actual}, expected ${expected}`);
	}
}
console.log("reservedOf: ok");

// --- palette: the reserve amount renders in its danger colour ---
const paletteDark = fmt.paletteColors(true);
const paletteLight = fmt.paletteColors(false);
if (paletteDark.danger !== "#f87171") throw new Error(`dark danger = ${paletteDark.danger}`);
if (paletteLight.danger !== "#dc2626") throw new Error(`light danger = ${paletteLight.danger}`);
console.log("reserved colour: dark", paletteDark.danger, "| light", paletteLight.danger);

// --- reserve row visibility: on-hold by default, permanent when the setting is on ---
const reservedVisibility = [
	[{ alwaysShowReserved: false }, 0, false],
	[{ alwaysShowReserved: false }, null, false],
	[{ alwaysShowReserved: false }, 42.78, true],
	[{ alwaysShowReserved: true }, 0, true],
	[{ alwaysShowReserved: true }, null, true],
	[{ alwaysShowReserved: true }, 42.78, true],
];
for (const [settingsFixture, reservedFixture, expected] of reservedVisibility) {
	const actual = fmt.shouldShowReserved(settingsFixture, reservedFixture);
	if (actual !== expected) {
		throw new Error(
			`shouldShowReserved(${JSON.stringify(settingsFixture)}, ${reservedFixture}) = ${actual}, expected ${expected}`,
		);
	}
}
if (fmt.sanitize({ alwaysShowReserved: true }, { alwaysShowReserved: false }).alwaysShowReserved !== true) {
	throw new Error("alwaysShowReserved was not preserved by sanitize()");
}
if (fmt.sanitize({}, { alwaysShowReserved: false }).alwaysShowReserved !== false) {
	throw new Error("alwaysShowReserved must default to false");
}
console.log("reserved visibility: ok");

// --- placement math: clamping and the profile-button anchor ---
const anchorNode = { getBoundingClientRect: () => ({ left: 8, top: 700, right: 272, bottom: 736, width: 264, height: 36 }) };
globalThis.document.querySelectorAll = (selector) => (selector === "[data-signed-out]" ? [anchorNode] : []);
const anchorTop = mod.__internals.accountAnchorTop();
if (anchorTop !== 700) throw new Error(`accountAnchorTop expected 700, got ${anchorTop}`);
const placement = mod.__internals.clampPos({ left: 16, top: anchorTop - 110 - 10 }, { width: 208, height: 110 });
if (placement.top + 110 > anchorTop) throw new Error("default placement overlaps the profile button");
if (placement.left < 8) throw new Error("default placement escaped the viewport");
const clampedLow = mod.__internals.clampPos({ left: -50, top: -20 }, { width: 208, height: 110 });
if (clampedLow.left !== 8 || clampedLow.top !== 8) throw new Error(`low clamp failed: ${JSON.stringify(clampedLow)}`);
const clampedHigh = mod.__internals.clampPos({ left: 5000, top: 5000 }, { width: 208, height: 110 });
if (clampedHigh.left !== 1280 - 208 - 8 || clampedHigh.top !== 800 - 110 - 8) {
	throw new Error(`high clamp failed: ${JSON.stringify(clampedHigh)}`);
}
mod.__internals.writePos({ left: 32, top: 240 });
const storedPos = mod.__internals.readPos();
if (!storedPos || storedPos.left !== 32 || storedPos.top !== 240) throw new Error("position was not persisted");
console.log("position math: anchor=700 placement=", placement, "clamp ok, persisted", storedPos);

// --- real MCP read path + incremental spend tracking ---
const TOKEN = process.env.POLZA_TOKEN;
if (!TOKEN) throw new Error("set POLZA_TOKEN to run the live part of this test");
const settings = mod.__internals.resolveSettings({ token: TOKEN, refreshSeconds: 60 });
console.log("settings:", {
	endpoint: settings.endpoint,
	refreshSeconds: settings.refreshSeconds,
	token: settings.token.slice(0, 12) + "…",
});

const scan = await mod.__internals.scanSpentToday(settings);
console.log("scanSpentToday:", scan);
const data = await mod.__internals.readBalance(settings, scan);
console.log("readBalance:", { ...data, spendState: undefined });
console.log(
	"formatted:",
	"Баланс " + mod.__internals.rub(data.available),
	"| Полный баланс " + mod.__internals.rub(data.balance),
	"| Зарезервировано " + mod.__internals.rub(data.reserved),
	"| Потрачено за сутки " + mod.__internals.rub(data.spentToday),
	"| Всего потрачено " + mod.__internals.rub(data.spentTotal),
);
if (typeof data.balance !== "number") throw new Error("balance did not parse");
if (typeof data.available !== "number") throw new Error("available did not parse");
if (typeof data.reserved !== "number") throw new Error("reserved did not parse");
if (typeof data.spentToday !== "number" || data.spentToday <= 0) throw new Error("today spend did not parse");
if (typeof data.spentTotal !== "number" || data.spentTotal <= 0) throw new Error("total spend did not parse");

const nextSpend = await mod.__internals.updateSpentToday(settings, scan);
if (nextSpend.sum < scan.sum) throw new Error(`spend went backwards: ${nextSpend.sum} < ${scan.sum}`);
console.log("incremental spend:", nextSpend.sum);

console.log("\nOK");
