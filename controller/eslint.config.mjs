import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

// eslint-config-next 16 ships a native flat-config array (see
// node_modules/eslint-config-next/dist/core-web-vitals.js). We spread it and
// layer our project-specific overrides on top.
const config = [
  { ignores: ['node_modules/**', '.next/**', 'data/**'] },
  ...nextCoreWebVitals,
  {
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
];

export default config;
