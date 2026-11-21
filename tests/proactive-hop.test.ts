import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_PROACTIVE_HOP_SETTINGS,
	MIN_PROACTIVE_HOP_INTERVAL_MS,
	PROACTIVE_HOP_BACKOFF_MS,
	ProactiveHopPolicy,
	proactiveHopSettingsFromEnv,
} from "../extensions/proactive-hop.ts";

const T0 = 1_700_000_000_000;

test("proactive rotation rotates once on a fresh run, then waits for the budget", () => {
	const clock = { now: T0 };
	const policy = new ProactiveHopPolicy(
		{ ...DEFAULT_PROACTIVE_HOP_SETTINGS, rotateAfterRequests: 3 },
		() => clock.now,
	);

	// Nothing rotated yet in this process: the persisted WARP block is stale.
	const first = policy.decision();
	assert.equal(first.hop, true);
	assert.equal(first.reason, "interval");

	policy.noteHop();
	assert.equal(policy.decision().hop, false);

	clock.now += MIN_PROACTIVE_HOP_INTERVAL_MS;
	policy.noteRequest();
	policy.noteRequest();
	assert.equal(policy.decision().hop, false);

	policy.noteRequest();
	const due = policy.decision();
	assert.equal(due.hop, true);
	assert.equal(due.reason, "budget");
	assert.equal(policy.hopCount, 1);
});

test("proactive rotation honours the minimum interval between hops", () => {
	const clock = { now: T0 };
	const policy = new ProactiveHopPolicy(
		{ ...DEFAULT_PROACTIVE_HOP_SETTINGS, rotateAfterRequests: 1 },
		() => clock.now,
	);

	policy.noteHop();
	policy.noteRequest();
	clock.now += 5_000;
	const blocked = policy.decision();
	assert.equal(blocked.hop, false);
	assert.equal(blocked.reason, "cooldown");

	clock.now += MIN_PROACTIVE_HOP_INTERVAL_MS;
	assert.equal(policy.decision().hop, true);
});

test("proactive rotation rotates an idle egress on the wall-clock net", () => {
	const clock = { now: T0 };
	const policy = new ProactiveHopPolicy(
		{ ...DEFAULT_PROACTIVE_HOP_SETTINGS, rotateAfterMs: 60_000 },
		() => clock.now,
	);

	policy.noteHop();
	assert.equal(policy.decision().hop, false);

	clock.now += 60_000;
	const due = policy.decision();
	assert.equal(due.hop, true);
	assert.equal(due.reason, "interval");
});

test("proactive rotation can be switched off and backs off after a failed hop", () => {
	const clock = { now: T0 };
	const policy = new ProactiveHopPolicy(
		{
			...DEFAULT_PROACTIVE_HOP_SETTINGS,
			enabled: false,
			rotateAfterRequests: 1,
		},
		() => clock.now,
	);

	assert.deepEqual(policy.decision(), {
		hop: false,
		reason: "off",
		detail: "proactive rotation off",
	});

	policy.configure({ enabled: true });
	policy.noteHop();
	policy.noteRequest();
	clock.now += MIN_PROACTIVE_HOP_INTERVAL_MS;
	assert.equal(policy.decision().hop, true);

	// A failed rotation must not be retried on every single turn.
	policy.noteHopFailure();
	const backedOff = policy.decision();
	assert.equal(backedOff.hop, false);
	assert.equal(backedOff.reason, "backoff");

	clock.now += PROACTIVE_HOP_BACKOFF_MS;
	assert.equal(policy.decision().hop, true);
});

test("proactive hop settings come from the environment without fail-open", () => {
	assert.deepEqual(proactiveHopSettingsFromEnv({}), DEFAULT_PROACTIVE_HOP_SETTINGS);
	assert.equal(
		proactiveHopSettingsFromEnv({ BANSOS_WARP_PROACTIVE: "0" }).enabled,
		false,
	);
	assert.equal(
		proactiveHopSettingsFromEnv({ BANSOS_WARP_ROTATE_EVERY: "50" })
			.rotateAfterRequests,
		50,
	);
	assert.equal(
		proactiveHopSettingsFromEnv({ BANSOS_WARP_ROTATE_MINUTES: "5" }).rotateAfterMs,
		5 * 60_000,
	);

	// Unparseable and below-minimum values keep the defaults instead of
	// silently disabling the rotation.
	const junk = proactiveHopSettingsFromEnv({
		BANSOS_WARP_ROTATE_EVERY: "nope",
		BANSOS_WARP_ROTATE_MINUTES: "0",
	});
	assert.equal(
		junk.rotateAfterRequests,
		DEFAULT_PROACTIVE_HOP_SETTINGS.rotateAfterRequests,
	);
	assert.equal(junk.rotateAfterMs, DEFAULT_PROACTIVE_HOP_SETTINGS.rotateAfterMs);
});
