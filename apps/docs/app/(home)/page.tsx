import Link from 'next/link';
import type { ReactNode } from 'react';
import pkg from '../../../../package.json' with { type: 'json' };
import { APP_URL, REPO_URL } from '../../lib/site';
import { ACCURACY } from './accuracy';
import { Frame } from './frame';

/**
 * The landing: what simulci answers, the app on a real repository, the rules it reads, how often it was right
 * against real runs, and the three ways to run it. Self-hosting joins when the image ships.
 */

const LAB_URL = `${REPO_URL}/tree/main/fixtures/routes-lab`;

const button = 'rounded-md px-4 py-2 font-medium';
const code = 'rounded bg-fd-muted px-1 py-0.5 font-mono text-[0.9em]';

function Heading({ id, eyebrow, children }: { id: string; eyebrow: string; children: ReactNode }) {
  return (
    <>
      <p className="font-mono text-xs tracking-widest text-fd-muted-foreground uppercase">{eyebrow}</p>
      <h2 id={id} className="mt-3 font-display text-3xl leading-tight font-medium tracking-tight sm:text-4xl">
        {children}
      </h2>
    </>
  );
}

const CONCEPTS: { slot: string; title: ReactNode; text: ReactNode; frame: string; dashed?: boolean }[] = [
  {
    slot: 'branch-filter',
    title: 'A branch filter',
    text: (
      <>
        <code className={code}>branches</code>, <code className={code}>paths</code> and{' '}
        <code className={code}>tags</code> against the event you describe: which workflows a push to{' '}
        <code className={code}>feat/x</code> starts, and why the others stay quiet.
      </>
    ),
    frame: 'on:\n  push:\n    branches: [main]\n\nmain     starts\nfeat/x   stays quiet',
  },
  {
    slot: 'needs-chain',
    title: (
      <>
        A <code className="font-mono">needs</code> chain
      </>
    ),
    text: (
      <>
        A job waits for the jobs it needs. When one of them skips or fails, simulci follows what GitHub does
        next, through <code className={code}>if:</code> and <code className={code}>always()</code>.
      </>
    ),
    frame: 'lint\n  ↓\ntest     skipped\n  ↓\ndeploy   skipped, as test',
  },
  {
    slot: 'maybe-fork',
    title: 'A “maybe” that names its unknown',
    text: (
      <>
        When the answer depends on something only the run knows, a step’s output or a variable, the job might
        run, and simulci names what it waits for. Pin that value and the plan answers.
      </>
    ),
    frame: "if: vars.DEPLOY == 'on'\n\n  ├─ runs\n  └─ skips\n\nmight run: vars.DEPLOY",
    dashed: true,
  },
  {
    slot: 'remote-workflow',
    title: 'A reusable workflow',
    text: (
      <>
        A workflow called with <code className={code}>uses:</code> is planned job by job. One from another
        repository is not fetched yet, so what it returns is an unknown the plan names.
      </>
    ),
    frame: 'release:\n  uses: acme/ci/…/release.yml@v2\n\noutputs.version   unknown',
  },
];

const WAYS: { title: string; snippet: string; text: ReactNode; links: { href: string; label: string }[] }[] =
  [
    {
      title: 'The CLI',
      snippet: 'npx simulci plan --event pull_request --head feat/x',
      text: (
        <>
          The plan for a scenario, every job and step with the reason that decided it, and{' '}
          <code className={code}>simulci test</code> for the route tests in your repository.
        </>
      ),
      links: [
        { href: '/docs/cli/plan', label: 'simulci plan' },
        { href: '/docs/cli/test', label: 'simulci test' },
      ],
    },
    {
      title: 'The Action',
      snippet: `- uses: ciatlas/simulci@v${pkg.version}`,
      text: 'The route tests on every pull request, with annotations on the line that decided and a job summary.',
      links: [{ href: '/docs/action', label: 'The Action' }],
    },
    {
      title: 'The app',
      snippet: APP_URL.replace('https://', ''),
      text: 'The same engine in a browser tab: the plan as a graph or as text, the YAML beside it, and your route tests in the Tests tab.',
      links: [
        { href: APP_URL, label: 'Open the app' },
        { href: '/docs/web-app', label: 'The web app' },
      ],
    },
  ];

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col-reverse justify-end border-t border-fd-border pt-4">
      <dt className="mt-1 text-sm text-fd-muted-foreground">{label}</dt>
      <dd className="font-display text-4xl font-medium tracking-tight tabular-nums sm:text-5xl">{value}</dd>
    </div>
  );
}

const link = (href: string, label: string, className: string) =>
  href.startsWith('/') ? (
    <Link href={href} className={className}>
      {label}
    </Link>
  ) : (
    <a href={href} className={className}>
      {label}
    </a>
  );

export default function HomePage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col px-4 sm:px-6">
      <section className="grid items-center gap-10 pt-16 pb-20 md:grid-cols-[1.15fr_1fr] md:pt-24">
        <div>
          <h1 className="font-display text-5xl leading-[1.05] font-medium tracking-tight sm:text-6xl">
            What your workflow does, before it runs.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-fd-muted-foreground">
            simulci reads your GitHub Actions workflows and a scenario (an event, a branch, the changed files)
            and tells you which jobs and steps run, skip or might run, and why. Nothing executes: no runner,
            no Docker.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href={APP_URL}
              className={`${button} bg-fd-primary text-fd-primary-foreground hover:opacity-90`}
            >
              Open the app
            </a>
            <Link href="/docs" className={`${button} border hover:bg-fd-accent`}>
              Get started
            </Link>
            <a href={REPO_URL} className={`${button} border hover:bg-fd-accent`}>
              GitHub
            </a>
          </div>
        </div>
        <Frame slot="event">{'on: pull_request\n  base: main\n  head: feat/x\n\n→ 4 of 6 workflows'}</Frame>
      </section>

      <section aria-labelledby="open-a-repository" className="border-t border-fd-border py-20">
        <div className="max-w-2xl">
          <Heading id="open-a-repository" eyebrow="The app">
            Open a repository. See what runs, and why.
          </Heading>
          <p className="mt-4 text-fd-muted-foreground">
            Open a checkout’s folder in the app: the scenario on the left, the run graph and the YAML in the
            middle, and on the right the line that decided each job. Your files stay in the page.
          </p>
        </div>
        <figure className="mt-10">
          {(['light', 'dark'] as const).map((theme) => (
            <img
              key={theme}
              src={`/landing/app-${theme}.jpg`}
              width={2048}
              height={1216}
              loading="lazy"
              alt="The simulci app on simulci’s own workflows: a push to main on the left, the run graph and release.yml in the middle, and on the right why Publish to npm might run, naming the output it waits for."
              className={`w-full rounded-lg border border-fd-border shadow-sm ${theme === 'light' ? 'dark:hidden' : 'hidden dark:block'}`}
            />
          ))}
          <figcaption className="mt-3 text-sm text-fd-muted-foreground">
            simulci’s own CI, opened as a folder.
          </figcaption>
        </figure>
      </section>

      <section aria-labelledby="what-it-reads" className="border-t border-fd-border py-20">
        <Heading id="what-it-reads" eyebrow="What it reads">
          The rules that decide a run.
        </Heading>
        <ul className="mt-12 grid gap-x-10 gap-y-14 sm:grid-cols-2">
          {CONCEPTS.map((c) => (
            <li key={c.slot}>
              <Frame slot={c.slot} {...(c.dashed ? { dashed: true } : {})}>
                {c.frame}
              </Frame>
              <h3 className="mt-6 font-display text-xl font-medium tracking-tight">{c.title}</h3>
              <p className="mt-2 text-fd-muted-foreground">{c.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="accuracy" className="border-t border-fd-border py-20">
        <Heading id="accuracy" eyebrow="Accuracy">
          Checked against real runs.
        </Heading>
        <dl className="mt-10 grid grid-cols-2 gap-6 md:grid-cols-4">
          <Stat value={ACCURACY.outcomes} label="observed outcomes" />
          <Stat value={ACCURACY.exact} label="predicted exactly" />
          <Stat value={ACCURACY.maybe} label="“might”, naming the unknown" />
          <Stat value={ACCURACY.wrong} label="predicted wrongly" />
        </dl>
        <p className="mt-10 max-w-3xl text-lg">{ACCURACY.sentence}</p>
        <p className="mt-4 text-fd-muted-foreground">Remote reusable workflows: not yet lab-verified.</p>
        <a
          href={LAB_URL}
          className="mt-6 inline-block font-medium text-fd-primary underline underline-offset-4"
        >
          How the lab measures it
        </a>
      </section>

      <section aria-labelledby="run-it" className="border-t border-fd-border py-20">
        <Heading id="run-it" eyebrow="Run it">
          In your terminal, on every pull request, in the browser.
        </Heading>
        <ul className="mt-12 grid gap-10 md:grid-cols-3">
          {WAYS.map((way) => (
            <li key={way.title} className="flex flex-col">
              <h3 className="font-display text-xl font-medium tracking-tight">{way.title}</h3>
              <pre className="mt-4 rounded-lg border bg-fd-card p-3 font-mono text-sm break-words whitespace-pre-wrap">
                <code>{way.snippet}</code>
              </pre>
              <p className="mt-4 text-fd-muted-foreground">{way.text}</p>
              <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                {way.links.map((l) => (
                  <span key={l.href}>
                    {link(l.href, l.label, 'font-medium text-fd-primary underline underline-offset-4')}
                  </span>
                ))}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
