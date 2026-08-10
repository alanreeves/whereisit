import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  /**
   * Static export for GitHub Pages.
   * All API calls go to Supabase Edge Functions — no Next.js server needed.
   */
  output: "export",

  /**
   * GitHub Pages serves the site at:
   *   https://alanreeves.github.io/whereisit/
   * so we need the /whereisit base path.
   * Override with NEXT_PUBLIC_BASE_PATH='' if you add a custom domain.
   */
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? (isProd ? "/whereisit" : ""),

  /**
   * Next.js image optimisation requires a server — disable for static export.
   */
  images: {
    unoptimized: true,
  },

  /**
   * Trailing slash makes GitHub Pages routing work correctly.
   * /about  →  /about/index.html
   */
  trailingSlash: true,
};

export default nextConfig;
