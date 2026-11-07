// Renders the widget with the real React 18 renderer inside a minimal
// DOM/window shim, to catch invalid elements, bad props and broken hook order.
// React itself is fetched once into tmp/react-cache and reused offline.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = path.resolve(PLUGIN_ROOT, "..");
const CACHE = path.join(WORKSPACE, "tmp", "react-cache");
fs.mkdirSync(CACHE, { recursive: true });
const nodeRequire = createRequire(import.meta.url);

async function grab(url, file) {
	const target = path.join(CACHE, file);
	if (!fs.existsSync(target)) {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`${url} -> ${response.status}`);
		fs.writeFileSync(target, await response.text());
	}
	return target;
}

function load(file, deps) {
	const module = { exports: {} };
	const require = (id) => (Object.prototype.hasOwnProperty.call(deps, id) ? deps[id] : nodeRequire(id));
	vm.runInThisContext(`(function (module, exports, require) {${fs.readFileSync(file, "utf8")}\n})`, { filename: file })(
		module,
		module.exports,
		require,
	);
	return module.exports;
}

const React = load(await grab("https://unpkg.com/react@18.3.1/cjs/react.production.min.js", "react.production.min.js"), {});
const ReactDOMServer = load(
	await grab(
		"https://unpkg.com/react-dom@18.3.1/cjs/react-dom-server-legacy.browser.production.min.js",
		"react-dom-server-legacy.browser.production.min.js",
	),
	{ react: React },
);
console.log("react", React.version, "| renderToStaticMarkup:", typeof ReactDOMServer.renderToStaticMarkup);

// --- browser shims ---
const stored = new Map();
globalThis.window = {
	__ModuleLoader__: { load: (definition) => (globalThis.__definition = definition) },
	localStorage: { getItem: (k) => (stored.has(k) ? stored.get(k) : null), setItem: (k, v) => stored.set(k, String(v)) },
	matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
	setInterval: () => 1,
	clearInterval() {},
	addEventListener() {},
	removeEventListener() {},
};
const documentShim = {
	body: { getAttribute: () => "true" },
	addEventListener() {},
	removeEventListener() {},
	querySelectorAll: () => [],
	visibilityState: "visible",
};
globalThis.document = documentShim;
globalThis.MutationObserver = class {
	observe() {}
	disconnect() {}
};

new Function("window", fs.readFileSync(path.join(PLUGIN_ROOT, "lib", "client.js"), "utf8"))(globalThis.window);
const definition = globalThis.__definition;
if (definition?.id !== "dsh-polza-balance") throw new Error("bundle did not register");

const mod = definition.factory((specifier) => {
	if (specifier === "react") return React;
	throw new Error(`unexpected require("${specifier}")`);
});

const settings = mod.__internals.resolveSettings({ token: "smoke", refreshSeconds: 60 });

// The panel was removed from the card body in 0.2.0: only balance, daily spend
// and the lifetime total stay, so the limit line and its progress bar are gone.
const darkHtml = ReactDOMServer.renderToStaticMarkup(
	React.createElement(mod.PolzaBalanceWidget, { initialSettings: settings }),
);
console.log("dark html length:", darkHtml.length);
console.log(darkHtml.slice(0, 300), "…");

for (const needle of [
	"polza.ai",
	"Баланс",
	"Потрачено за сутки",
	"Всего потрачено",
	"position:fixed",
	"left:16px",
	"top:594px",
	"cursor:grab",
	"touch-action:none",
	"⟳",
	"Обновить сейчас",
	"⚙",
	"rgba(32, 32, 36, 0.92)",
	"text-align:right",
]) {
	if (!darkHtml.includes(needle)) throw new Error(`missing in dark HTML: ${needle}`);
}
// Both optional rows stay hidden by default (no data, permanent display off) …
for (const banned of [
	"Лимит в сутки",
	"Токен polza.ai",
	"rgba(15, 23, 42, 0.10)",
	"font-size:12.5px",
	"руб",
	"Зарезервировано",
	"Полный баланс",
]) {
	if (darkHtml.includes(banned)) throw new Error(`unexpected in card HTML: ${banned}`);
}
if (!/position:fixed/.test(darkHtml)) throw new Error("not fixed");
if (!/left:\d+px/.test(darkHtml)) throw new Error("no left anchor");
if (!/top:\d+px/.test(darkHtml)) throw new Error("no top anchor");

// … but the settings force them into the markup even before any data arrives.
// "Полный баланс" follows "Зарезервировано": forcing the reserve shows both.
const forced = mod.__internals.resolveSettings({ token: "smoke", alwaysShowReserved: true });
const forcedHtml = ReactDOMServer.renderToStaticMarkup(
	React.createElement(mod.PolzaBalanceWidget, { initialSettings: forced }),
);
if (!forcedHtml.includes("Зарезервировано")) throw new Error("alwaysShowReserved did not render the reserved row");
if (!forcedHtml.includes("Полный баланс")) throw new Error("the full-balance row must follow the reserved row");
if (forcedHtml.includes("#f87171")) throw new Error("a zero reserve must not use the danger colour");
console.log("forced reserved + full-balance rows: ok");

// … and "Полный баланс" has its own permanent switch, independent of the reserve.
const forcedFull = mod.__internals.resolveSettings({ token: "smoke", alwaysShowFullBalance: true });
const forcedFullHtml = ReactDOMServer.renderToStaticMarkup(
	React.createElement(mod.PolzaBalanceWidget, { initialSettings: forcedFull }),
);
if (!forcedFullHtml.includes("Полный баланс")) throw new Error("alwaysShowFullBalance did not render the full-balance row");
if (!forcedFullHtml.includes("#60a5fa")) throw new Error("the full-balance amount must use the blue accent colour");
if (forcedFullHtml.includes("Зарезервировано")) throw new Error("alwaysShowFullBalance must not show the reserved row");
console.log("forced full-balance row: ok");

// Settings sanitization: the removed daily-limit field must not survive.
const legacy = mod.__internals.sanitize(
	{ token: "t", refreshSeconds: 5, dailyLimitRub: 999 },
	{ token: "", endpoint: "https://polza.ai/api/mcp", refreshSeconds: 60 },
);
if ("dailyLimitRub" in legacy) throw new Error("dailyLimitRub must be dropped from settings");
if (legacy.refreshSeconds !== 15) throw new Error(`refreshSeconds floor failed: ${legacy.refreshSeconds}`);

// Currency formatting: apostrophe thousands separator and the ₽ sign.
if (mod.__internals.rub(1236.36) !== "1'236,36 ₽") throw new Error(`rub() = ${mod.__internals.rub(1236.36)}`);
if (mod.__internals.money(1234567.891) !== "1'234'567,89") throw new Error("thousands grouping failed");

documentShim.body.getAttribute = () => "false";
const lightHtml = ReactDOMServer.renderToStaticMarkup(
	React.createElement(mod.PolzaBalanceWidget, { initialSettings: settings }),
);
if (!lightHtml.includes("rgba(255, 255, 255, 0.94)")) throw new Error("light palette not applied");
console.log("light html length:", lightHtml.length);

// The blue amount follows the light palette too.
const lightForced = ReactDOMServer.renderToStaticMarkup(
	React.createElement(mod.PolzaBalanceWidget, {
		initialSettings: mod.__internals.resolveSettings({ token: "smoke", alwaysShowFullBalance: true }),
	}),
);
if (!lightForced.includes("#2563eb")) throw new Error("the light theme must use #2563eb for the full-balance amount");
console.log("light full-balance colour: ok");

console.log("card text:", darkHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
console.log("\nOK: render passed for both themes");
