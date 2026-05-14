import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './index.module.css';

function Hero() {
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <div className={styles.heroBadge}>
          <span className={styles.heroBadgeDot} /> alpha · API may change before 1.0
        </div>
        <Heading as="h1" className={styles.heroTitle}>
          One command. Every device. Parallel.
        </Heading>
        <p className={styles.heroTagline}>
          <code>maestro-parallel</code> orchestrates Maestro flows across every connected iOS simulator,
          iOS device and Android phone — auto-detects your build pipeline, runs flows in parallel,
          merges the JUnit. No glue scripts.
        </p>
        <div className={styles.heroInstall}>
          <pre>
            <code>
              <span className={styles.heroPromptC}>$</span>{' '}
              <span className={styles.heroPromptW}>deno install --global --reload --allow-all -n maestro-parallel \</span>
              {'\n  '}
              <span className={styles.heroPromptW}>jsr:@kaln/maestro-parallel/cli</span>
            </code>
          </pre>
        </div>
        <div className={styles.heroCtas}>
          <Link className={styles.heroCtaPrimary} to="/docs/getting-started">
            Get started →
          </Link>
          <Link
            className={styles.heroCtaSecondary}
            href="https://github.com/TomKalina/maestro-parallel"
          >
            GitHub
          </Link>
        </div>
      </div>
      <div className={styles.heroGlow} aria-hidden />
    </header>
  );
}

function TerminalPreview() {
  return (
    <section className={styles.terminalSection}>
      <div className={styles.terminalWrap}>
        <div className={styles.terminalChrome}>
          <span className={styles.dotR} />
          <span className={styles.dotY} />
          <span className={styles.dotG} />
          <span className={styles.terminalTitle}>maestro-parallel</span>
        </div>
        <pre className={styles.terminal}>
          <code>
            <span className={styles.tBox}>┌</span>{'  '}
            <span className={styles.tCyan}><b>maestro-parallel</b></span>{'\n'}
            <span className={styles.tBox}>│</span>{'\n'}
            <span className={styles.tStep}>◇</span>{'  '}
            <span><b>configuration</b></span>{' '}
            <span className={styles.tBox}>──────────────────────────────────────────╮</span>{'\n'}
            <span className={styles.tBox}>│</span>{'  '}
            <span className={styles.tDim}>cwd:</span> /Users/tom/devenv/cms4/admin_mobile/Shoptet
            {'                                            '}
            <span className={styles.tBox}>│</span>{'\n'}
            <span className={styles.tBox}>│</span>{'  '}
            <span className={styles.tDim}>build:</span> expo run:* (Release / release) via pnpm
            {'                                          '}
            <span className={styles.tBox}>│</span>{'\n'}
            <span className={styles.tBox}>│</span>{'  '}
            <span className={styles.tDim}>buildMode:</span> release
            {'                                                                   '}
            <span className={styles.tBox}>│</span>{'\n'}
            <span className={styles.tBox}>├────────────────────────────────────────────────────────────────────╯</span>{'\n'}
            <span className={styles.tBox}>│</span>{'\n'}
            <span className={styles.tStep}>◇</span>{'  '}
            <span><b>Build & install</b></span>{'\n'}
            <span className={styles.tBox}>│</span>{'  '}
            <span className={styles.tGreen}>◇</span>{' '}
            expo run:android done <span className={styles.tDim}>(63.9s)</span>{'\n'}
            <span className={styles.tBox}>│</span>{'  '}
            <span className={styles.tGreen}>◇</span>{' '}
            expo run:ios done <span className={styles.tDim}>(86.4s)</span>{'\n'}
            <span className={styles.tBox}>│</span>{'\n'}
            <span className={styles.tStep}>◇</span>{'  '}
            <span><b>Maestro tests</b></span>{'\n'}
            <span className={styles.tBox}>│</span>{'  '}
            <span className={styles.tCyan}>[ios:iPhone 17 Pro]</span>{' '}
            <span className={styles.tGreen}>[Passed]</span> login_flow (15s){'\n'}
            <span className={styles.tBox}>│</span>{'  '}
            <span className={styles.tMag}>[and:Pixel 6a]</span>{' '}
            <span className={styles.tGreen}>[Passed]</span> login_flow (29s){'\n'}
            <span className={styles.tBox}>│</span>{'\n'}
            <span className={styles.tBox}>└</span>{'  '}
            <span className={styles.tGreen}>4/4 devices passed</span>
          </code>
        </pre>
      </div>
    </section>
  );
}

const features: { title: string; body: string }[] = [
  {
    title: 'Build once. Install many.',
    body:
      'mp builds your release artifact on the first device of each platform group, then ' +
      'reuse-installs the same .apk / .app on every other device. One xcodebuild run for five sims.',
  },
  {
    title: 'Auto-detected build pipeline.',
    body:
      'Rock → EAS local → expo run:* — mp picks whichever your project uses. Override declaratively ' +
      'with one line of config when projects ship multiple.',
  },
  {
    title: 'Real parallel execution.',
    body:
      'Android Maestro processes run in parallel, iOS sequentially (safe default) or ' +
      'opt-in --shard-all. Staggered process starts dodge Maestro 2.5.x log-dir races.',
  },
  {
    title: 'Picker that remembers.',
    body:
      'TTY checklist with last-selection memory. Skip with --all in CI. Broken adb devices and missing ' +
      'iOS sim runtimes are surfaced with actionable hints, not stack traces.',
  },
  {
    title: 'Merged JUnit, ready to ship.',
    body:
      'Every device writes its own report.xml plus a merged file at the top level. ' +
      'CI parsers see one suite — pass/fail aggregates across platforms.',
  },
  {
    title: 'Hooks you can write.',
    body:
      'Auto-detect not enough? Drop a buildAndInstallFirst into your config. The runner does the ' +
      'reuse-install fan-out, signal handling, log files and JUnit merge for you.',
  },
];

function Features() {
  return (
    <section className={styles.featuresSection}>
      <div className={styles.featuresInner}>
        <Heading as="h2" className={styles.featuresHeading}>
          Why mp
        </Heading>
        <div className={styles.featuresGrid}>
          {features.map((f) => (
            <div key={f.title} className={styles.featureCard}>
              <h3 className={styles.featureTitle}>{f.title}</h3>
              <p className={styles.featureBody}>{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className={styles.finalSection}>
      <div className={styles.finalInner}>
        <Heading as="h2" className={styles.finalHeading}>
          Ready to stop running Maestro five times?
        </Heading>
        <div className={styles.finalCtas}>
          <Link className={styles.heroCtaPrimary} to="/docs/getting-started">
            Get started
          </Link>
          <Link className={styles.heroCtaSecondary} to="/docs/configuration">
            Config reference
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout
      title="Run Maestro flows on every device in parallel"
      description="maestro-parallel orchestrates Maestro flows across every connected iOS simulator, iOS device and Android phone — auto-detects your build pipeline, runs flows in parallel, merges JUnit."
    >
      <Hero />
      <TerminalPreview />
      <Features />
      <FinalCta />
    </Layout>
  );
}
