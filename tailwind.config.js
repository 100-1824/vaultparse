/** Tailwind is compiled at build time by scripts/build.js (no runtime CDN). */
module.exports = {
  darkMode: 'class',
  content: ['./dist/**/*.html', './src/js/**/*.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace']
      }
    }
  },
  plugins: []
};
