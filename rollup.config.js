import { readFileSync } from 'node:fs';
import resolve from '@rollup/plugin-node-resolve';
import copy from "rollup-plugin-copy";
import terser from '@rollup/plugin-terser';
import replace from '@rollup/plugin-replace';

// Only a published release carries a real version; every other build (local or
// branch CI) falls back to manifest.json so the banner never reads "main".
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const ref = process.env.RELEASE_VERSION || manifest.version || 'dev';
const isPreRelease = process.env.PRE_RELEASE === 'true';

const plugins = [
  resolve(),
  replace({ 
    preventAssignment: true, 
    __VERSION__: ref,
  }),
  !isPreRelease && terser(),
  copy({
    targets: [
      {
        src: "src/*.png",
        dest: "dist",
      },
    ],
    hook: "writeBundle",
    verbose: true,
    }),
].filter(Boolean);

export default {
  input: 'src/enhanced-shutter-card.js',
  output: {
    file: 'dist/enhanced-shutter-card.js',
    format: 'es',
  },
  plugins,
};
