/**
 * Tailwind v4 does its own nesting, autoprefixing and vendor handling through
 * Lightning CSS, so the classic `postcss-nested` / `autoprefixer` pair is not
 * only unnecessary here but actively conflicts with it. Keep this list minimal;
 * a plugin added "for convenience" is the usual way a Tailwind v4 build starts
 * emitting subtly different CSS between dev and the static desktop export.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
