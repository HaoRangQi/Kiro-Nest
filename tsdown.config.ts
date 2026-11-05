import { defineConfig } from 'tsdown'

/**
 * Bundle the standalone gateway.
 *
 * The bundle only uses Node built-ins, which keeps the runtime Docker image
 * free of node_modules.
 */
export default defineConfig({
  entry: ['lib/types/gateway/main.js'],
  outDir: 'lib/gateway',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
