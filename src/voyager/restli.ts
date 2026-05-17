// Rest.li 2.0 "compound key" / GraphQL variables encoder.
//
// LinkedIn's Voyager GraphQL endpoint accepts the `variables=` query param
// in a custom syntax (NOT JSON):
//
//   (k:v,k2:List(a,b,c),k3:(nested:value))
//
// - Objects:   (k1:v1,k2:v2)
// - Lists:     List(a,b,c)         (empty list -> List())
// - Strings:   percent-encoded for any char that would conflict with the
//              syntax: ( ) , : & # plus URL-unsafe chars.
// - Numbers/bools: verbatim ("true", "false", "42")
//
// This is the recursive version of mautrix-linkedin's `queriesToString`
// (pkg/linkedingo/request.go) — the Go callers pre-encode values, but
// we let callers pass structured data and encode here.

export type RestLiValue = string | number | boolean | RestLiList | RestLiObject;
export interface RestLiObject {
  [k: string]: RestLiValue;
}
export type RestLiList = RestLiValue[];

const STRUCTURAL = new Set(["(", ")", ",", ":"]);

// Percent-encode anything that would break the Rest.li grammar, plus URL-unsafe
// chars. We start from encodeURIComponent (which already escapes most things
// safely) and then additionally escape `( ) , : ! * ' #` (encodeURIComponent
// leaves some of those alone) so the value can't be confused with structural
// syntax.
function encodeString(s: string): string {
  let out = encodeURIComponent(s);
  // encodeURIComponent leaves these unencoded, but they break our grammar:
  // ( ) ! * '
  // Also the colon : -- encodeURIComponent leaves it alone in some envs.
  // Comma , is already encoded by encodeURIComponent.
  out = out.replace(/[()!*']/g, (c) => {
    return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
  });
  // Defensive: also encode raw structural chars if any slipped through.
  out = out.replace(/[:,]/g, (c) => {
    return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
  });
  // # is encoded by encodeURIComponent, & is encoded by encodeURIComponent.
  // Sanity: ensure nothing in STRUCTURAL remains.
  for (const ch of STRUCTURAL) {
    if (out.includes(ch)) {
      throw new Error(`encodeString failed to escape ${ch} in ${s}`);
    }
  }
  return out;
}

function encodeValue(v: RestLiValue): string {
  if (typeof v === "string") return encodeString(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error(`Cannot encode non-finite number: ${v}`);
    }
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return encodeList(v);
  if (typeof v === "object" && v !== null) return encodeObject(v);
  throw new Error(`Unsupported Rest.li value type: ${typeof v}`);
}

function encodeList(list: RestLiList): string {
  return "List(" + list.map(encodeValue).join(",") + ")";
}

function encodeObject(obj: RestLiObject): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    parts.push(`${k}:${encodeValue(v)}`);
  }
  return "(" + parts.join(",") + ")";
}

export function encodeRestLi(value: RestLiObject): string {
  return encodeObject(value);
}
