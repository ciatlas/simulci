/**
 * Imported first by each worker, so it listens before anything else runs. The CSP binds the workers too (the header
 * table, headers.ts, gives it to their scripts), and a refusal there reaches no page script and no test: the browser
 * only notes it in the worker's own log. Said as an error, it reaches the page's console, where the browser pass fails
 * on it.
 */

export const describeViolation = (event: SecurityPolicyViolationEvent): string =>
  `the CSP refused ${event.blockedURI || 'an inline source'} (${event.effectiveDirective}) at ${event.sourceFile}:${event.lineNumber}`;

addEventListener('securitypolicyviolation', (event) => {
  console.error(describeViolation(event));
});
