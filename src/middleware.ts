import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  hasMemberAccess,
  hasSmartAnalysisAccess,
  isAdminEmail,
} from "@/lib/auth/subscription";

const MEMBER_PAGES = ["/analyze", "/matches"];
const SMART_PAGES = ["/smart-analysis"];
const MEMBER_API = ["/api/fixtures", "/api/analyze", "/api/archive-table"];
const SMART_API = ["/api/smart-analysis"];

function matchesPrefix(pathname: string, paths: string[]): boolean {
  return paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  let response = NextResponse.next({ request });

  const isMemberRoute =
    matchesPrefix(pathname, MEMBER_PAGES) || matchesPrefix(pathname, MEMBER_API);
  const isSmartRoute =
    matchesPrefix(pathname, SMART_PAGES) || matchesPrefix(pathname, SMART_API);

  if (!isMemberRoute && !isSmartRoute) {
    return response;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value, options }) => {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
    }
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }

  if (isAdminEmail(user.email ?? "")) {
    return response;
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("subscription_status,is_admin,plan_id")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[middleware] profiles", error.message);
  }

  if (!hasMemberAccess(profile, user.email)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Active subscription required." },
        { status: 403 },
      );
    }
    const account = new URL("/account", request.url);
    account.searchParams.set("upgrade", "1");
    return NextResponse.redirect(account);
  }

  if (isSmartRoute && !hasSmartAnalysisAccess(profile, user.email)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Smart Analysis requires Pro plan or higher." },
        { status: 403 },
      );
    }
    const account = new URL("/account", request.url);
    account.searchParams.set("upgrade", "smart");
    return NextResponse.redirect(account);
  }

  return response;
}

export const config = {
  matcher: [
    "/analyze/:path*",
    "/matches/:path*",
    "/smart-analysis/:path*",
    "/api/fixtures/:path*",
    "/api/analyze/:path*",
    "/api/archive-table/:path*",
    "/api/smart-analysis/:path*",
    "/login",
    "/account",
    "/auth/:path*",
  ],
};
