/**
 * The redaction rule table — published methodology, ordered, deterministic.
 *
 * PRIVACY CONTRACT for this module: redaction is DEFENSE IN DEPTH, never the
 * privacy backstop (PRD §16 Q3). The primary mechanism is the schema itself —
 * `SessionEvent` v1 has no free-text fields, so the normalized event stream
 * is safe by construction. These rules exist for the free-text surfaces that
 * live outside the event stream: redacted session summaries (PRD §10),
 * opt-in crash reports (PRD §8), and Rich-mode excerpts if E1 keeps them.
 *
 * ATTRIBUTION: secret patterns derived from gitleaks
 * (https://github.com/gitleaks/gitleaks), MIT License, Copyright (c) 2019
 * Zachary Rice — ported from `config/gitleaks.toml` at commit
 * `09242ce9c8a60d9b051fc2d166f9e849b88c7ac0`. Gitleaks-derived rules keep the
 * upstream rule id verbatim so a refresh diff against upstream is reviewable.
 *
 * PORT NOTES (Go/RE2 → JS): inline `(?i)` flags are hoisted to the regex's
 * `i` flag (rules mixing case-sensitive and -insensitive parts are rewritten
 * with explicit character classes); gitleaks' consumed trailing-delimiter
 * groups `(?:[\x60'"\s;]|\\[nr]|$)` become lookaheads `(?=…)` — RE2 lacks
 * lookahead, JS doesn't, and not consuming the delimiter lets two adjacent
 * secrets on one line both match.
 *
 * CURATION PRINCIPLE: a high-signal subset (~30 rules), not all ~190 upstream
 * rules. Every included rule must be explainable in one line and testable
 * with a fake-but-format-valid corpus fixture (`__fixtures__/secrets-corpus
 * .json` — coverage is enforced by the release-gate test). Obscure vendor
 * tokens our users' transcripts will never contain only add false-positive
 * surface; `generic-api-key` is the keyword+entropy catch-all floor.
 */

export interface RedactionRule {
	/** kebab-case id; gitleaks-derived rules keep the upstream gitleaks id. */
	id: string;
	category: "secret" | "email" | "path" | "env-value" | "credential-url";
	/** One-line published-methodology description (user-facing in the public repo). */
	description: string;
	/** MUST have the `g` flag; matched per-application, never stateful across calls. */
	pattern: RegExp;
	/** 1-based capture group holding the secret; whole match redacted when absent. */
	secretGroup?: number;
	/** Min Shannon entropy of the (group) match for the rule to fire. */
	minEntropy?: number;
}

/**
 * Applied strictly in declared order: specific vendor rules before `jwt`
 * before `generic-api-key` before `env-value-assignment` before
 * `credential-url` before `email-address` before `absolute-home-path` —
 * most-specific first so findings name the most precise rule, and paths
 * last so a path inside an already-redacted match doesn't double-fire.
 */
export const REDACTION_RULES: ReadonlyArray<RedactionRule> = [
	// gitleaks:private-key — PEM private-key blocks, multiline.
	{
		id: "private-key",
		category: "secret",
		description: "PEM-encoded private key block",
		pattern:
			/-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----/gi,
	},
	// gitleaks:aws-access-token — AWS access key id (AKIA/ASIA/… prefixes).
	{
		id: "aws-access-token",
		category: "secret",
		description: "AWS access key ID",
		pattern: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/g,
		secretGroup: 1,
		minEntropy: 3,
	},
	// gitleaks:github-pat — classic GitHub personal access token.
	{
		id: "github-pat",
		category: "secret",
		description: "GitHub personal access token (classic)",
		pattern: /ghp_[0-9a-zA-Z]{36}/g,
		minEntropy: 3,
	},
	// gitleaks:github-fine-grained-pat — fine-grained GitHub PAT.
	{
		id: "github-fine-grained-pat",
		category: "secret",
		description: "GitHub fine-grained personal access token",
		pattern: /github_pat_\w{82}/g,
		minEntropy: 3,
	},
	// gitleaks:github-oauth — GitHub OAuth access token.
	{
		id: "github-oauth",
		category: "secret",
		description: "GitHub OAuth access token",
		pattern: /gho_[0-9a-zA-Z]{36}/g,
		minEntropy: 3,
	},
	// gitleaks:github-app-token — GitHub App installation/server token.
	{
		id: "github-app-token",
		category: "secret",
		description: "GitHub App token",
		pattern: /(?:ghu|ghs)_[0-9a-zA-Z]{36}/g,
		minEntropy: 3,
	},
	// gitleaks:github-refresh-token — GitHub refresh token.
	{
		id: "github-refresh-token",
		category: "secret",
		description: "GitHub refresh token",
		pattern: /ghr_[0-9a-zA-Z]{36}/g,
		minEntropy: 3,
	},
	// gitleaks:gitlab-pat — GitLab personal access token.
	{
		id: "gitlab-pat",
		category: "secret",
		description: "GitLab personal access token",
		pattern: /glpat-[\w-]{20}/g,
		minEntropy: 3,
	},
	// gitleaks:slack-bot-token — Slack bot token.
	{
		id: "slack-bot-token",
		category: "secret",
		description: "Slack bot token",
		pattern: /xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/g,
		minEntropy: 3,
	},
	// gitleaks:slack-user-token — Slack user/legacy token.
	{
		id: "slack-user-token",
		category: "secret",
		description: "Slack user token",
		pattern: /xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}/g,
		minEntropy: 2,
	},
	// gitleaks:slack-webhook-url — Slack incoming-webhook URL (the path IS the credential).
	{
		id: "slack-webhook-url",
		category: "secret",
		description: "Slack webhook URL",
		pattern:
			/(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/g,
	},
	// gitleaks:stripe-access-token — Stripe secret/restricted key.
	{
		id: "stripe-access-token",
		category: "secret",
		description: "Stripe secret or restricted API key",
		pattern:
			/\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?=[\x60'"\s;]|\\[nr]|$)/g,
		secretGroup: 1,
		minEntropy: 2,
	},
	// gitleaks:openai-api-key — OpenAI API key (legacy and project-scoped forms).
	{
		id: "openai-api-key",
		category: "secret",
		description: "OpenAI API key",
		pattern:
			/\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?=[\x60'"\s;]|\\[nr]|$)/g,
		secretGroup: 1,
		minEntropy: 3,
	},
	// gitleaks:anthropic-api-key — first-class, not generic-rule fallthrough:
	// our own coaching stack's keys are the ones most likely to land in dev transcripts.
	{
		id: "anthropic-api-key",
		category: "secret",
		description: "Anthropic API key",
		pattern: /\b(sk-ant-api03-[a-zA-Z0-9_-]{93}AA)(?=[\x60'"\s;]|\\[nr]|$)/g,
		secretGroup: 1,
	},
	// gitleaks:anthropic-admin-api-key — Anthropic admin API key.
	{
		id: "anthropic-admin-api-key",
		category: "secret",
		description: "Anthropic admin API key",
		pattern: /\b(sk-ant-admin01-[a-zA-Z0-9_-]{93}AA)(?=[\x60'"\s;]|\\[nr]|$)/g,
		secretGroup: 1,
	},
	// gitleaks:gcp-api-key — Google Cloud API key.
	{
		id: "gcp-api-key",
		category: "secret",
		description: "Google Cloud API key",
		pattern: /\b(AIza[\w-]{35})(?=[\x60'"\s;]|\\[nr]|$)/g,
		secretGroup: 1,
		minEntropy: 4,
	},
	// gitleaks:npm-access-token — npm registry access token.
	{
		id: "npm-access-token",
		category: "secret",
		description: "npm access token",
		pattern: /\b(npm_[a-z0-9]{36})(?=[\x60'"\s;]|\\[nr]|$)/gi,
		secretGroup: 1,
		minEntropy: 2,
	},
	// gitleaks:pypi-upload-token — PyPI upload token.
	{
		id: "pypi-upload-token",
		category: "secret",
		description: "PyPI upload token",
		pattern: /pypi-AgEIcHlwaS5vcmc[\w-]{50,1000}/g,
		minEntropy: 3,
	},
	// gitleaks:huggingface-access-token — Hugging Face access token.
	// Upstream `hf_(?i:[a-z]{34})` scoped-insensitive body rewritten as an explicit class.
	{
		id: "huggingface-access-token",
		category: "secret",
		description: "Hugging Face access token",
		pattern: /\b(hf_[a-zA-Z]{34})(?=[\x60'"\s;]|\\[nr]|$)/g,
		secretGroup: 1,
		minEntropy: 2,
	},
	// gitleaks:sendgrid-api-token — SendGrid API token.
	// Upstream `SG\.(?i)…` mixed-sensitivity form rewritten with an explicit class.
	{
		id: "sendgrid-api-token",
		category: "secret",
		description: "SendGrid API token",
		pattern: /\b(SG\.[a-zA-Z0-9=_.-]{66})(?=[\x60'"\s;]|\\[nr]|$)/g,
		secretGroup: 1,
		minEntropy: 2,
	},
	// gitleaks:twilio-api-key — Twilio API key SID.
	{
		id: "twilio-api-key",
		category: "secret",
		description: "Twilio API key",
		pattern: /SK[0-9a-fA-F]{32}/g,
		minEntropy: 3,
	},
	// gitleaks:flyio-access-token — Fly.io API token (product stack, PRD §8 hosting row).
	{
		id: "flyio-access-token",
		category: "secret",
		description: "Fly.io access token",
		pattern:
			/\b(fo1_[\w-]{43}|fm1[ar]_[a-zA-Z0-9+/]{100,}={0,3}|fm2_[a-zA-Z0-9+/]{100,}={0,3})(?=[\x60'"\s;]|\\[nr]|$)/g,
		secretGroup: 1,
		minEntropy: 4,
	},
	// Product-stack rule gitleaks lacks (PRD §8 email row): Resend API key.
	{
		id: "resend-api-key",
		category: "secret",
		description: "Resend API key",
		pattern: /\bre_[a-zA-Z0-9_]{20,}\b/g,
		minEntropy: 2,
	},
	// Product-stack rule gitleaks lacks: Notion internal-integration token.
	// First-class rather than left to `generic-api-key` because the highest-risk
	// surface is a BARE token pasted into prose — a user describing a bug in the
	// in-app report form has no `key =` keyword for the generic rule to anchor
	// on, and the value would sail through. Notion's current tokens are
	// `ntn_` + a ~46-char base62 body (the legacy `secret_…` form is covered by
	// `generic-api-key` when assigned); the 40–64 length floor plus the entropy
	// gate keeps ordinary prose that happens to contain "ntn_" untouched.
	{
		id: "notion-integration-token",
		category: "secret",
		description: "Notion integration token",
		pattern: /\b(ntn_[A-Za-z0-9]{40,64})(?=[\x60'"\s;]|\\[nr]|$)/g,
		secretGroup: 1,
		minEntropy: 3,
	},
	// gitleaks:jwt — three-segment JSON Web Token. Supabase anon/service keys
	// are JWTs, making this our stack's most likely leak (PRD §8 Supabase row).
	{
		id: "jwt",
		category: "secret",
		description: "JSON Web Token",
		pattern:
			/\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/\\_-]{17,}\.(?:[a-zA-Z0-9/\\_-]{10,}={0,2})?)(?=[\x60'"\s;]|\\[nr]|$)/g,
		secretGroup: 1,
		minEntropy: 3,
	},
	// gitleaks:generic-api-key — keyword-anchored assignment with a high-entropy
	// value; the catch-all floor under every vendor-specific rule above.
	// Upstream's `(?-i:[Aa]pi|API)` scoped-sensitive group flattens to `api`
	// under the hoisted `i` flag (slightly broader, never narrower).
	{
		id: "generic-api-key",
		category: "secret",
		description:
			"Generic credential assignment (keyword-anchored, entropy-gated)",
		pattern:
			/[\w.-]{0,50}?(?:access|auth|api|credential|creds|key|passw(?:or)?d|secret|token)[ \t\w.-]{0,20}[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([\w.=-]{10,150}|[a-z0-9][a-z0-9+/]{11,}={0,3})(?=[\x60'"\s;]|\\[nr]|$)/gi,
		secretGroup: 1,
		minEntropy: 3.5,
	},
	// PRD §9 "env values" never-transmitted clause: the VALUE of a secret-named
	// env assignment, regardless of entropy (catches low-entropy real passwords
	// the generic rule's gate deliberately skips). The variable NAME is a useful
	// debugging signal and is not sensitive — only group 2 (the value) is redacted.
	{
		id: "env-value-assignment",
		category: "env-value",
		description: "Value assigned to a secret-named environment variable",
		pattern:
			/\b(?:export\s+)?([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g,
		secretGroup: 2,
	},
	// PRD §9 "credentials" clause: userinfo password in URLs
	// (postgres://user:pass@…, https://x:token@github.com, redis://:pass@…).
	// Runs before email-address so the local-part heuristic never wins first.
	{
		id: "credential-url",
		category: "credential-url",
		description: "Password embedded in a URL's userinfo section",
		pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@:]*:)([^\s/@]+)@/g,
		secretGroup: 2,
	},
	// PRD §9 "email addresses" clause.
	{
		id: "email-address",
		category: "email",
		description: "Email address",
		pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
	},
	// PRD §9 "full file paths" clause: absolute home-rooted paths (macOS /Users,
	// Linux /home, Windows C:\Users). The WHOLE path is redacted, not just the
	// username — full paths are never transmitted. Last in the table so a path
	// inside an already-redacted match can't double-fire.
	{
		id: "absolute-home-path",
		category: "path",
		description: "Absolute path under a user home directory",
		pattern:
			/\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[^\s"'\x60]+)?|[A-Z]:\\Users\\[^\s"'\x60\\]+(?:\\[^\s"'\x60]+)?/g,
	},
];
