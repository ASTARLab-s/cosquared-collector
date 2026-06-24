import { defineConfig } from "vitest/config";

// The public packages are offline, deterministic suites — no env, no network.
export default defineConfig({
	test: {
		projects: ["packages/*"],
		passWithNoTests: true,
	},
});
