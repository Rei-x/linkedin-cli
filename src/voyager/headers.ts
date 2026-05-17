// Header builders for the LinkedIn Voyager API.
//
// Mirrors mautrix-linkedin's `Default*Headers`, `WithXLIHeaders`,
// `WithRealtimeConnectHeaders`, and `getCSRFToken` from
// pkg/linkedingo/request.go and pkg/linkedingo/client.go.

export interface HeaderContext {
  jsessionid: string;
  xLiTrack?: string;
  xLiPageInstance?: string;
  userAgent?: string;
}

const CHROME_VERSION = "148";

export const DEFAULT_USER_AGENT =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;

const SEC_CH_UA =
  `"Chromium";v="${CHROME_VERSION}", "Google Chrome";v="${CHROME_VERSION}", "Not/A)Brand";v="99"`;

const SERVICE_VERSION = "1.13.44203";

export const DEFAULT_X_LI_TRACK = JSON.stringify({
  clientVersion: SERVICE_VERSION,
  mpVersion: SERVICE_VERSION,
  osName: "web",
  deviceFormFactor: "DESKTOP",
  mpName: "voyager-web",
  displayDensity: 2,
  displayWidth: 2880,
  displayHeight: 1800,
});

export const DEFAULT_X_LI_PAGE_INSTANCE =
  "urn:li:page:messaging_thread;5accf988-7540-4d0a-8a28-a0732bf6de20";

const MESSAGING_BASE_URL = "https://www.linkedin.com/messaging";

const CONTENT_TYPE_JSON_LINKEDIN_NORMALIZED =
  "application/vnd.linkedin.normalized+json+2.1";
const CONTENT_TYPE_GRAPHQL = "application/graphql";

// csrf-token derives from JSESSIONID but LinkedIn strips the surrounding double
// quotes that appear in the cookie value (real browser traffic confirms this).
export function csrfTokenFor(jsessionid: string): string {
  if (
    jsessionid.length >= 2 &&
    jsessionid.startsWith('"') &&
    jsessionid.endsWith('"')
  ) {
    return jsessionid.slice(1, -1);
  }
  return jsessionid;
}

export function defaultHeaders(ctx: HeaderContext): Record<string, string> {
  return {
    "User-Agent": ctx.userAgent ?? DEFAULT_USER_AGENT,
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "csrf-token": csrfTokenFor(ctx.jsessionid),
    "Sec-Ch-Ua": SEC_CH_UA,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Origin: "https://www.linkedin.com",
  };
}

export function withXLIHeaders(
  base: Record<string, string>,
  ctx: HeaderContext,
): Record<string, string> {
  return {
    ...base,
    Referer: `${MESSAGING_BASE_URL}/`,
    "x-li-page-instance": ctx.xLiPageInstance ?? DEFAULT_X_LI_PAGE_INSTANCE,
    "x-li-track": ctx.xLiTrack ?? DEFAULT_X_LI_TRACK,
    "x-restli-protocol-version": "2.0.0",
  };
}

export function withRealtimeHeaders(
  base: Record<string, string>,
  ctx: HeaderContext,
  realtimeSessionId: string,
  queryMap: string,
  recipeMap: string,
): Record<string, string> {
  const withXli = withXLIHeaders(base, ctx);
  return {
    ...withXli,
    "x-li-accept": CONTENT_TYPE_JSON_LINKEDIN_NORMALIZED,
    "x-li-query-accept": CONTENT_TYPE_GRAPHQL,
    "x-li-query-map": queryMap,
    "x-li-recipe-accept": CONTENT_TYPE_JSON_LINKEDIN_NORMALIZED,
    "x-li-recipe-map": recipeMap,
    "x-li-realtime-session": realtimeSessionId,
    Priority: "u=1, i",
  };
}
