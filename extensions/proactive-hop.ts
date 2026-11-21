/**
 * Proactive WARP /64 rotation policy.
 *
 * OpenCode meters its free tier per egress IP, so a busy session reaches the
 * wall long before the daily counter resets. The reactive path in index.ts
 * waits for the `429` and hops afterwards, which still spends one refused turn
 * on the way. This policy rotates the /64 *ahead* of the wall: after a request
 * budget's worth of turns on one block, and on a wall-clock safety net for
 * traffic that is slow but long-lived.
 *
 * Pure state machine — no network, no timers, no imports: the caller drives it,
 * and the tests drive it with an injected clock.
 */

export type ProactiveHopSettings = {
	/** Master switch (`BANSOS_WARP_PROACTIVE=0`, `/bansos warp proactive off`). */
	enabled: boolean;
	/** Rotate after this many OpenCode turns on the current /64. */
	rotateAfterRequests: number;
	/** Rotate after this long on the current /64, even when the turn budget is not spent. */
	rotateAfterMs: number;
	/** Never rotate more often than this (mirrors the engine's own hop cooldown). */
	minHopIntervalMs: number;
};

export const MIN_PROACTIVE_HOP_INTERVAL_MS = 45_000;
export const PROACTIVE_HOP_BACKOFF_MS = 60_000;

export const DEFAULT_PROACTIVE_HOP_SETTINGS: ProactiveHopSettings = {
	enabled: true,
	rotateAfterRequests: 20,
	rotateAfterMs: 20 * 60_000,
	minHopIntervalMs: MIN_PROACTIVE_HOP_INTERVAL_MS,
};

export type ProactiveHopEnv = Record<string, string | undefined>;

/**
 * Settings from `BANSOS_WARP_PROACTIVE` / `BANSOS_WARP_ROTATE_EVERY` /
 * `BANSOS_WARP_ROTATE_MINUTES`. A value that does not parse (or is below its
 * minimum) keeps the default instead of silently switching protection off.
 */
export function proactiveHopSettingsFromEnv(
	env: ProactiveHopEnv = process.env,
): ProactiveHopSettings {
	const num = (raw: string | undefined, fallback: number, min: number): number => {
		const n = Number(raw);
		return Number.isFinite(n) && n >= min ? n : fallback;
	};
	return {
		enabled: env.BANSOS_WARP_PROACTIVE !== "0",
		rotateAfterRequests: Math.floor(
			num(
				env.BANSOS_WARP_ROTATE_EVERY,
				DEFAULT_PROACTIVE_HOP_SETTINGS.rotateAfterRequests,
				1,
			),
		),
		rotateAfterMs:
			Math.floor(
				num(
					env.BANSOS_WARP_ROTATE_MINUTES,
					DEFAULT_PROACTIVE_HOP_SETTINGS.rotateAfterMs / 60_000,
					1,
				),
			) * 60_000,
		minHopIntervalMs: MIN_PROACTIVE_HOP_INTERVAL_MS,
	};
}

export type ProactiveHopReason =
	| "budget"
	| "interval"
	| "off"
	| "cooldown"
	| "backoff"
	| "quiet";

export type ProactiveHopDecision = {
	hop: boolean;
	reason: ProactiveHopReason;
	detail: string;
};

export class ProactiveHopPolicy {
	private settings: ProactiveHopSettings;
	private readonly now: () => number;
	private requests = 0;
	private lastHopAt = 0;
	private backoffUntil = 0;
	private hops = 0;

	// Fields are assigned here rather than declared as constructor parameter
	// properties: Node's type stripping (no code generation) rejects those.
	constructor(
		settings: ProactiveHopSettings = DEFAULT_PROACTIVE_HOP_SETTINGS,
		now: () => number = Date.now,
	) {
		this.settings = settings;
		this.now = now;
	}

	getSettings(): ProactiveHopSettings {
		return { ...this.settings };
	}

	/** Live changes from `/bansos warp proactive on|off`. */
	configure(patch: Partial<ProactiveHopSettings>): void {
		this.settings = { ...this.settings, ...patch };
	}

	get hopCount(): number {
		return this.hops;
	}

	/** Count one OpenCode turn (a whole turn, not one HTTP attempt). */
	noteRequest(): void {
		this.requests += 1;
	}

	/** The /64 rotated successfully: the fresh block starts with a clean budget. */
	noteHop(at: number = this.now()): void {
		this.requests = 0;
		this.lastHopAt = at;
		this.backoffUntil = 0;
		this.hops += 1;
	}

	/** A rotation failed: stop retrying it on every single turn. */
	noteHopFailure(
		backoffMs = PROACTIVE_HOP_BACKOFF_MS,
		at: number = this.now(),
	): void {
		this.backoffUntil = at + backoffMs;
	}

	decision(at: number = this.now()): ProactiveHopDecision {
		if (!this.settings.enabled)
			return { hop: false, reason: "off", detail: "proactive rotation off" };
		if (at < this.backoffUntil) {
			const secs = Math.ceil((this.backoffUntil - at) / 1000);
			return {
				hop: false,
				reason: "backoff",
				detail: `last rotation failed, retry in ${secs}s`,
			};
		}
		if (
			this.lastHopAt > 0 &&
			at - this.lastHopAt < this.settings.minHopIntervalMs
		) {
			const secs = Math.ceil(
				(this.settings.minHopIntervalMs - (at - this.lastHopAt)) / 1000,
			);
			return {
				hop: false,
				reason: "cooldown",
				detail: `rotation cooldown ${secs}s`,
			};
		}
		if (this.requests >= this.settings.rotateAfterRequests)
			return {
				hop: true,
				reason: "budget",
				detail: `${this.requests} turns on this /64`,
			};
		// Nothing rotated yet in this process: the persisted WARP account still
		// carries the block from the previous run, which is usually spent.
		if (this.lastHopAt === 0)
			return {
				hop: true,
				reason: "interval",
				detail: "no fresh /64 yet this run",
			};
		if (at - this.lastHopAt >= this.settings.rotateAfterMs) {
			const mins = Math.round((at - this.lastHopAt) / 60_000);
			return {
				hop: true,
				reason: "interval",
				detail: `${mins}m on this /64`,
			};
		}
		return {
			hop: false,
			reason: "quiet",
			detail: `${this.requests}/${this.settings.rotateAfterRequests} turns on this /64`,
		};
	}

	/** True while a failed rotation is waiting out its backoff. */
	isBackingOff(at: number = this.now()): boolean {
		return at < this.backoffUntil;
	}

	/** One line for `/bansos warp status`. */
	summary(at: number = this.now()): string {
		if (!this.settings.enabled)
			return "OFF (BANSOS_WARP_PROACTIVE=0 or /bansos warp proactive off)";
		const decision = this.decision(at);
		const rotations = this.hops ? `, ${this.hops} rotation(s)` : "";
		return `ON — ${decision.detail}${rotations}`;
	}
}
