/**
 * Uniform-error assertion for negative/validation specs (§11): awaits a
 * repository call that MUST fail and asserts the backend's typed refusal —
 * `code` (the contract) and `status`, never message text (§6).
 * Fails loudly when the call unexpectedly succeeds.
 */
import { ApiError } from '../api/errors';
import { expect } from '../assertions/traceo.matchers';

export async function expectApiError(
  call: Promise<unknown>,
  expected: { status: number; code: string },
): Promise<ApiError> {
  const outcome = await call.then(
    (value) => ({ threw: false as const, value }),
    (error: unknown) => ({ threw: true as const, error }),
  );
  if (!outcome.threw) {
    throw new Error(
      `Expected refusal ${expected.status} '${expected.code}', but the call succeeded: ` +
        JSON.stringify(outcome.value),
    );
  }
  expect(outcome.error).toBeInstanceOf(ApiError);
  const err = outcome.error as ApiError;
  expect(err.code).toBe(expected.code);
  expect(err.status).toBe(expected.status);
  return err;
}
