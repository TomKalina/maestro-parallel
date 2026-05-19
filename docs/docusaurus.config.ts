import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'maestro-parallel',
  tagline: 'Run Maestro flows on every iOS / Android device in parallel',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://maestro-parallel.pages.dev',
  baseUrl: '/',

  organizationName: 'TomKalina',
  projectName: 'maestro-parallel',

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/docs',
          editUrl: 'https://github.com/TomKalina/maestro-parallel/tree/main/docs/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'maestro-parallel',
      items: [
        { to: '/docs', label: 'Docs', position: 'left' },
        {
          href: 'https://github.com/TomKalina/maestro-parallel',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting started', to: '/docs/getting-started' },
            { label: 'Configuration', to: '/docs/configuration' },
            { label: 'Build strategies', to: '/docs/build-strategies' },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'GitHub', href: 'https://github.com/TomKalina/maestro-parallel' },
            { label: 'Issues', href: 'https://github.com/TomKalina/maestro-parallel/issues' },
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} Tomáš Kalina · MIT licence`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'yaml', 'typescript'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
