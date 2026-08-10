/**
 * proxy.ts  (formerly middleware.ts — renamed in Next.js 16)
 * Supabase session refresh proxy for Next.js App Router.
 * Runs before every matched request to keep the auth session alive.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: Do not remove — refreshes the session token on every request.
  await supabase.auth.getUser();

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static  (static assets)
     * - _next/image   (image optimisation)
     * - favicon.ico, sitemap.xml, robots.txt, manifest.json
     * - sw.js         (service worker — must be unintercepted)
     * - icon files
     */
    "/((?!_next/static|_next/image|favicon\\.ico|sitemap\\.xml|robots\\.txt|manifest\\.json|sw\\.js|icons/).*)",
  ],
};
