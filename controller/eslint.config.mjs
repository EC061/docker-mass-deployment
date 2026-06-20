import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'

export default [
  { ignores: ['node_modules/**', '.next/**', 'data/**'] },
  ...nextCoreWebVitals,
  {
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
]
