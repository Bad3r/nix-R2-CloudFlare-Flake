/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

// Fontsource packages are CSS-only and ship no type declarations; TypeScript 6
// requires side-effect imports to resolve (ts2882), so declare them ambient.
declare module "@fontsource-variable/martian-mono";
declare module "@fontsource-variable/spline-sans-mono";
