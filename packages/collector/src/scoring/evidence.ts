import type { SessionEvent } from "@cosquared/schema";
import type { EvidenceRef } from "./types";
import { MAX_EVIDENCE_REFS } from "./weights";

/** The checkable-artifact citation for one event (PRD §7.6). */
export function evidenceRef(event: SessionEvent): EvidenceRef {
	return {
		sessionId: event.sessionId,
		source: event.source,
		timestamp: event.timestamp,
	};
}

/** First {@link MAX_EVIDENCE_REFS} qualifying events as citations. */
export function cappedRefs(events: SessionEvent[]): EvidenceRef[] {
	return events.slice(0, MAX_EVIDENCE_REFS).map(evidenceRef);
}
