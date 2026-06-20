// Ambient declaration for CSS side-effect imports (e.g. `import "./globals.css"`).
// TypeScript 6 tightened typing of side-effect imports for non-code modules; without
// this, tsc reports TS2882 for the global stylesheet imported in src/app/layout.tsx.
declare module '*.css';
