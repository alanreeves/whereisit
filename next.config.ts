import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Serve Service Worker from root with correct headers
  headers: async () => [
    {
      source: "/sw.js",
      headers: [
        { key: "Cache-Control",  value: "no-cache, no-store, must-revalidate" },
        { key: "Service-Worker-Allowed", value: "/" },
        { key: "Content-Type",   value: "application/javascript; charset=utf-8" },
      ],
    },
    {
      source: "/manifest.json",
      headers: [
        { key: "Content-Type", value: "application/manifest+json" },
        { key: "Cache-Control", value: "public, max-age=3600" },
      ],
    },
  ],
};

export default nextConfig;
