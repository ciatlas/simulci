import { z } from 'zod';

/**
 * What an author writes to pin a unit: `assume` entries (per test case or file, or on the command line). A mock
 * states only what the runner would have produced: the outcome, the outputs, the `$GITHUB_ENV` writes. What the run
 * derives (conclusions, `needs.*.result`, skips) is never written.
 */

const Scalar = z.union([z.string(), z.number(), z.boolean()]);
/** A value, or `{ unknown: true }` to un-pin one a model or an earlier layer set. */
export const MockValueSchema = z.union([Scalar, z.strictObject({ unknown: z.literal(true) })]);
export type MockValue = z.infer<typeof MockValueSchema>;

export const OutcomeSchema = z.enum(['success', 'failure', 'cancelled']);

export const AssumeEntrySchema = z
  .strictObject({
    /** `ci.yml`, `.github/workflows/ci.yml` or `ci`: required when the job id exists in several workflows of the config. */
    workflow: z.string().min(1).optional(),
    /** A step, by unit path (`build.unit`, `test[os=windows-latest].#2`, `rel/build.v`, `build.setup/cache`). */
    step: z.string().min(1).optional(),
    /** A job, by unit path (`deploy`, `rel/build`); its `outcome` applies at the job boundary. */
    job: z.string().min(1).optional(),
    /** Every step or calling job whose `uses:` matches (`actions/cache@v4`, `./.github/actions/x`, `o/r/.github/workflows/d.yml`), within `job` when given. */
    uses: z.string().min(1).optional(),
    /** Matrix values that select legs, as an alternative to `[k=v]` in the path. */
    matrix: z.record(z.string(), Scalar).optional(),
    outcome: OutcomeSchema.optional(),
    outputs: z.record(z.string(), MockValueSchema).optional(),
    /** `$GITHUB_ENV` writes the step makes, read by the steps after it. */
    env: z.record(z.string(), MockValueSchema).optional(),
    /** A named case of a config model or a preset of a shipped model (`hit`, `miss`). */
    as: z.string().min(1).optional(),
  })
  .refine(
    (e) =>
      e.step !== undefined
        ? e.job === undefined && e.uses === undefined
        : e.job !== undefined || e.uses !== undefined,
    {
      message: 'name a step, a job, or a uses pattern (with a job as its scope)',
    },
  )
  .refine(
    (e) => e.outcome !== undefined || e.outputs !== undefined || e.env !== undefined || e.as !== undefined,
    {
      message: 'state an outcome, outputs, env or as',
    },
  )
  .refine((e) => e.job === undefined || e.uses !== undefined || e.env === undefined, {
    message: 'env writes belong to a step',
  });

export type AssumeEntry = z.infer<typeof AssumeEntrySchema>;
export const AssumeListSchema = z.array(AssumeEntrySchema);

/** The layers an author's mocks come in, closest to the test last. */
export type AssumeLayer = 'given' | 'case' | 'cli';

export interface MockLayers {
  given?: AssumeEntry[];
  case?: AssumeEntry[];
  cli?: AssumeEntry[];
}
