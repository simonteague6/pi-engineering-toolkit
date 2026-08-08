import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "total-ctx-usage";

/** Backwards-compatible extension entry point for the historical status key. */
export default function totalContextUsage(pi: ExtensionAPI): void {
	pi.on("turn_end", (_event, ctx) => {
		const tokens = ctx.getContextUsage()?.tokens;
		ctx.ui.setStatus(
			STATUS_KEY,
			tokens === undefined || tokens === null ? undefined : `ctx ${Math.floor(tokens / 1_000)}k`,
		);
	});
}
