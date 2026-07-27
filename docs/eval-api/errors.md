# Evaluation API v1 — error types

All failures use `application/problem+json` and carry an `X-Request-Id`. The
response `type` URI links directly to one of the stable fragments below.

## unauthorized

**HTTP 401.** The API key is missing, malformed, unknown, or revoked.

## insufficient-scope

**HTTP 403.** The key does not have the scope required by the endpoint.

## inspect-test-mode-only

**HTTP 403.** A live key called `inspect`, which is available only to test-mode
keys.

## invalid-json

**HTTP 400.** The request body is not valid JSON.

## payload-too-large

**HTTP 413.** The declared request body exceeds the 1 MiB limit.

## invalid-request

**HTTP 422.** The strict request schema rejected the payload. Inspect the
response `issues` extension for field-level details.

## invalid-idempotency-key

**HTTP 422.** The `Idempotency-Key` exceeds 255 characters.

## invalid-limit

**HTTP 422.** The requested pagination limit is invalid.

## invalid-cursor

**HTTP 422.** The pagination cursor is invalid.

## evaluation-not-found

**HTTP 404.** No evaluation with that ID exists in the key's project and mode.

## storage-failure

**HTTP 500.** The evaluation could not be stored. Retry safely with the same
idempotency key and include the request ID if the problem persists.

## read-failure

**HTTP 500.** Evaluations could not be read. Retry the request and include the
request ID if the problem persists.
