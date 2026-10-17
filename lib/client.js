window.__ModuleLoader__.load({
	id: "dsh-codex-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		//#region usage-badge
		/** Same-origin host route serving the ChatGPT subscription rate limits. */
		const USAGE_URL = "/plugins/dsh-codex-connect/usage";

		/** 18000s -> "5h", 604800s -> "7d" */
		function windowLabel(seconds) {
			if (!seconds) return "";
			const h = Math.round(seconds / 3600);
			if (h <= 0) return "";
			return h % 24 === 0 ? h / 24 + "d" : h + "h";
		}

		function resetLabel(seconds) {
			if (typeof seconds !== "number" || seconds < 0) return "";
			const d = Math.floor(seconds / 86400);
			const h = Math.floor((seconds % 86400) / 3600);
			const m = Math.floor((seconds % 3600) / 60);
			if (d > 0) return d + "d" + (h > 0 ? h + "h" : "");
			if (h > 0) return h + "h" + (m > 0 ? m + "m" : "");
			return m + "m";
		}

		function pct(v) {
			return typeof v === "number" && Number.isFinite(v) ? Math.round(v) + "%" : "?";
		}

		function barColor(used, limitReached) {
			if (limitReached) return "#ef4444";
			if (typeof used !== "number") return "#6b7280";
			if (used >= 90) return "#ef4444";
			if (used >= 70) return "#f59e0b";
			return "#22c55e";
		}

		function WindowBar(props) {
			const win = props.win;
			if (!win) return null;
			const used = win.usedPercent;
			const remain = typeof used === "number" ? Math.max(0, Math.min(100, 100 - used)) : 0;
			const reset = resetLabel(win.resetAfterSeconds);
			const tip = (windowLabel(win.windowSeconds) || "") + " window: used " + pct(used) +
				", left " + pct(remain) + (reset ? ", resets in " + reset : "");
			return React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 3 }, title: tip },
				React.createElement("span", { style: { fontSize: 10, opacity: 0.6 } }, windowLabel(win.windowSeconds)),
				React.createElement("span", { style: { display: "inline-block", width: 40, height: 4, borderRadius: 2, background: "#404040", overflow: "hidden" } },
					React.createElement("span", { style: { display: "block", height: "100%", width: remain + "%", background: barColor(used, props.limitReached) } })),
				React.createElement("span", { style: { fontSize: 11 } }, pct(remain)));
		}

		function CodexUsageBadge() {
			const [state, setState] = React.useState({ loading: true, data: null, error: null });

			const load = React.useCallback((force) => {
				setState((s) => Object.assign({}, s, { loading: true }));
				fetch(USAGE_URL + (force ? "?force=1" : ""), { credentials: "same-origin" })
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
					.then((data) => setState({ loading: false, data, error: null }))
					.catch((error) => setState((s) => Object.assign({}, s, { loading: false, error: error.message })));
			}, []);

			React.useEffect(() => { load(false); }, [load]);

			React.useEffect(() => {
				const d = state.data;
				if (!d) return undefined;
				const resets = [
					d.primary && d.primary.resetAfterSeconds,
					d.secondary && d.secondary.resetAfterSeconds,
				].filter((v) => typeof v === "number");
				if (!resets.length) return undefined;
				const delay = Math.min.apply(null, resets) * 1000;
				const timer = setTimeout(() => load(true), Math.max(5000, Math.min(delay, 3600000)));
				return () => clearTimeout(timer);
			}, [state.data, load]);

			const d = state.data;
			if (!d) return React.createElement("button", {
				onClick: () => load(true), disabled: state.loading,
				title: state.error ? "Codex 用量获取失败（" + state.error + "），点击重试" : "正在获取 Codex 用量",
				style: { background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 11, opacity: 0.7 },
			}, state.loading ? "Codex 用量加载中…" : "Codex 用量暂不可用 ↻");

			const resets = [
				d.primary && d.primary.resetAfterSeconds,
				d.secondary && d.secondary.resetAfterSeconds,
			].filter((v) => typeof v === "number");
			const soonest = resets.length ? Math.min.apply(null, resets) : null;

			return React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11 } },
				React.createElement("span", { style: { opacity: 0.7 } }, d.planType ? String(d.planType).toUpperCase() : "CODEX"),
				React.createElement(WindowBar, { win: d.primary, limitReached: d.limitReached }),
				React.createElement(WindowBar, { win: d.secondary, limitReached: d.limitReached }),
				d.limitReached
					? React.createElement("span", { style: { color: "#ef4444" } }, "limit reached")
					: (soonest != null
						? React.createElement("span", { style: { opacity: 0.55 } }, resetLabel(soonest) + " to reset")
						: null),
				React.createElement("button", {
					onClick: () => load(true),
					title: "Refresh Codex usage",
					"aria-label": "Refresh Codex usage",
					style: { background: "none", border: "none", cursor: "pointer", color: "inherit", opacity: 0.55, fontSize: 12, padding: 0 },
				}, "\u21bb"));
		}
		//#endregion

		const name = "dsh-codex-connect";
		const inject = ["slots"];

		/** Best-effort contribution guard mirroring the first-party plugins. */
		function guard(label, fn) {
			try { return fn(); } catch (error) {
				console.error("[dsh-codex-connect] " + label + " failed", error);
				return undefined;
			}
		}

		function apply(clientCtx) {
			// "conversation.input.right" is a list-kind slot, so register() needs
			// name + id, and the component is the SECOND argument.
			guard("usage badge slot", () => clientCtx.slots.inject("conversation.input.right", () =>
				guard("usage badge register", () => clientCtx.slots.register({
					name: "conversation.input.right",
					id: "codex-usage-badge",
					order: 20,
				}, CodexUsageBadge))));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
