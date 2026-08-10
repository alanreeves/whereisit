import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { APP_VERSION } from "@/lib/version";

// Load Inter via next/font (self-hosted, no external @import needed)
const inter = Inter({
  subsets:  ["latin"],
  weight:   ["300", "400", "500", "600", "700"],
  variable: "--font-inter",
  display:  "swap",
});

export const metadata: Metadata = {
  title:       "Where Is It?",
  description: "Voice-first household inventory tracker. Find anything, anywhere.",
  manifest:    "/manifest.json",
  icons: {
    icon:  [
      { url: "/icons/icon-96x96.png",  sizes: "96x96",   type: "image/png" },
      { url: "/icons/icon-192x192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [
      { url: "/icons/icon-180x180.png", sizes: "180x180", type: "image/png" },
    ],
    shortcut: "/favicon.png",
  },
  appleWebApp: {
    capable:        true,
    statusBarStyle: "black-translucent",
    title:          "Where Is It?",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  themeColor:   "#07071a",
  width:        "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit:  "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <link rel="icon" href="/icons/icon-96x96.png" type="image/png" sizes="96x96" />
        <link rel="icon" href="/favicon.png" type="image/png" />
        <link rel="apple-touch-icon" href="/icons/icon-180x180.png" sizes="180x180" />
        <link rel="apple-touch-icon" href="/icons/icon-192x192.png" sizes="192x192" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body>
        {children}
        {/* Service Worker registration */}
        <script
          id="sw-register"
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js', { scope: '/' })
                    .then(function(reg) {
                      console.log('[App] SW registered, scope:', reg.scope);
                      reg.addEventListener('updatefound', function() {
                        var nw = reg.installing;
                        if (nw) {
                          nw.addEventListener('statechange', function() {
                            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                              console.log('[App] New SW available \u2014 v${APP_VERSION}');
                            }
                          });
                        }
                      });
                    })
                    .catch(function(err) {
                      console.warn('[App] SW registration failed:', err);
                    });
                  navigator.serviceWorker.addEventListener('message', function(event) {
                    if (event.data && event.data.type === 'SW_ACTIVATED') {
                      console.log('[App] SW activated, version:', event.data.version);
                    }
                  });
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
