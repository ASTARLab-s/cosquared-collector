import type { SessionEvent } from "@cosquared/schema";

/** One AI session's events, sorted by timestamp. */
export interface SessionView {
	sessionId: string;
	events: SessionEvent[];
}

export interface SegmentedEvents {
	/** Sessions ordered by their first event's timestamp. */
	sessions: SessionView[];
	/** Repo-scope events (`sessionId === null`), sorted by timestamp. */
	repoEvents: SessionEvent[];
	/**
	 * The engine's clock: the max timestamp across ALL events. Scoring
	 * never reads the wall clock (purity contract) — "the last 14 days"
	 * always means the 14 days ending here, so re-scoring an old stream is
	 * byte-identical forever.
	 */
	referenceTime: string | null;
}

function byTimestamp(a: SessionEvent, b: SessionEvent): number {
	return Date.parse(a.timestamp) - Date.parse(b.timestamp);
}

/**
 * Segments the flat normalized stream into per-session views plus
 * repo-scope events. Grouping is strictly by `sessionId` — events from
 * different collectors (Claude Code today, Cursor/Codex later) share the
 * stream, so segmentation must not assume source homogeneity within a
 * session. Sorting is stable: events sharing a timestamp keep their
 * stream order.
 */
export function segmentSessions(events: SessionEvent[]): SegmentedEvents {
	const eventsBySessionId = new Map<string, SessionEvent[]>();
	const repoEvents: SessionEvent[] = [];
	let referenceMillis = Number.NEGATIVE_INFINITY;
	let referenceTime: string | null = null;

	for (const event of events) {
		if (event.sessionId === null) {
			repoEvents.push(event);
		} else {
			const group = eventsBySessionId.get(event.sessionId) ?? [];
			group.push(event);
			eventsBySessionId.set(event.sessionId, group);
		}
		const millis = Date.parse(event.timestamp);
		if (millis > referenceMillis) {
			referenceMillis = millis;
			referenceTime = event.timestamp;
		}
	}

	const sessions = [...eventsBySessionId.entries()]
		.map(([sessionId, sessionEvents]) => ({
			sessionId,
			events: sessionEvents.sort(byTimestamp),
		}))
		.sort((a, b) => byTimestamp(a.events[0], b.events[0]));

	return {
		sessions,
		repoEvents: repoEvents.sort(byTimestamp),
		referenceTime,
	};
}
