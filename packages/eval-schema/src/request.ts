import { z } from "zod";
import { EvalOpaqueIdSchema, EvaluationEventSchema } from "./event";

export const EvalProfileKeySchema = z.enum([
	"ai_collaboration_v1",
	"software_delivery_v1",
]);

export const EvalWindowSchema = z
	.strictObject({
		start: z.iso.datetime(),
		end: z.iso.datetime(),
	})
	.refine((window) => Date.parse(window.end) >= Date.parse(window.start), {
		message: "window.end must be greater than or equal to window.start",
		path: ["end"],
	});

export const EvaluationRequestSchema = z
	.strictObject({
		subject: EvalOpaqueIdSchema,
		external_session_id: EvalOpaqueIdSchema.nullable(),
		window: EvalWindowSchema.nullable(),
		profiles: z.array(EvalProfileKeySchema).min(1),
		events: z.array(EvaluationEventSchema).min(1).max(5000),
	})
	.superRefine((request, context) => {
		request.events.forEach((event, index) => {
			if (event.subject !== request.subject) {
				context.addIssue({
					code: "custom",
					message: "event subject must match request subject",
					path: ["events", index, "subject"],
				});
			}
		});
	});

export type ProfileKey = z.infer<typeof EvalProfileKeySchema>;
export type EvaluationRequest = z.infer<typeof EvaluationRequestSchema>;
