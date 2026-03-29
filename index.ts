#!/usr/bin/env bun

const BASE = "https://backend.kronan.is/api";
const DEFAULT_STORE = "145"; // Krónan Miðbæ (Flókagata group picking store)

interface SearchBody {
  query: string;
  onlyInSelection: boolean;
  onlyInSpecializedSelection: boolean;
  page: number;
  pageSize: number;
  storeExtIds: string[];
  includeWholesale: boolean;
  sortBy: string;
}

interface Product {
  name: string;
  sku: string;
  categoryId: number;
  thumbnail: string;
  price: number;
  isPublished: boolean;
  inProductSelection: boolean;
  temporaryShortage: boolean;
  priceInfo: string;
  chargedByWeight: boolean;
  baseComparisonUnit: string;
  detail?: {
    discountedPrice: number;
    discountPercent: number;
    onSale: boolean;
    tags: { slug: string; name: string; image: string }[];
  };
}

interface SearchResponse {
  count: number;
  page: number;
  pageCount: number;
  hasNextPage: boolean;
  results: {
    hits: Product[];
    facets: Record<string, unknown>;
  };
}

interface Category {
  id: number;
  slug: string;
  name: string;
  children?: Category[];
}

interface Store {
  id: number;
  extId: string;
  name: string;
  displayName: string;
  address: string;
  city: string;
  postalCode: string;
  hasPickup: boolean;
  hasPicking: boolean;
  isScanNGo: boolean;
  isWholesale: boolean;
}

// --- Auth ---

const COGNITO_REGION = "eu-west-1";
const COGNITO_CLIENT_ID = "26cfceo8iffeoulsfnkopgfnbv";
const COOKIES_PATH = new URL(".cookies", import.meta.url);
const GROUP_PATH = new URL(".group", import.meta.url);

interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  [key: string]: unknown;
}

function readCookies(): CookieEntry[] {
  try {
    return JSON.parse(require("fs").readFileSync(COOKIES_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function writeCookies(cookies: CookieEntry[]) {
  require("fs").writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
}

function isExpired(jwt: string): boolean {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString()
    );
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

async function refreshIdToken(refreshToken: string): Promise<string> {
  const resp = await fetch(
    `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    }
  );
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token refresh failed: ${resp.status} ${body}`);
  }
  const data = await resp.json();
  return data.AuthenticationResult.IdToken;
}

async function resolveToken(): Promise<string> {
  if (process.env.KRONAN_TOKEN) return process.env.KRONAN_TOKEN;

  const cookies = readCookies();
  const idCookie = cookies.find((c) => c.name === "id_token");
  const refreshCookie = cookies.find((c) => c.name === "refresh_token");

  if (idCookie && !isExpired(idCookie.value)) {
    return idCookie.value;
  }

  if (refreshCookie) {
    const newToken = await refreshIdToken(refreshCookie.value);
    // Update .cookies with new id_token
    if (idCookie) {
      idCookie.value = newToken;
    } else {
      cookies.push({
        name: "id_token",
        value: newToken,
        domain: "kronan.is",
      });
    }
    writeCookies(cookies);
    return newToken;
  }

  console.error(
    "No auth found. Set KRONAN_TOKEN or place .cookies file (JSON array from browser)."
  );
  process.exit(1);
}

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    authorization: `CognitoJWT ${await resolveToken()}`,
  };
  const groupId = readGroupId();
  if (groupId) headers["customer-group-id"] = String(groupId);
  return headers;
}

async function api(path: string, opts?: RequestInit): Promise<unknown> {
  const resp = await fetch(`${BASE}${path}`, opts);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`${opts?.method || "GET"} ${path}: ${resp.status} ${body}`);
  }
  return resp.json();
}

// Public endpoints
async function search(
  query: string,
  opts: { page?: number; pageSize?: number; store?: string } = {}
): Promise<SearchResponse> {
  const body: SearchBody = {
    query,
    onlyInSelection: false,
    onlyInSpecializedSelection: false,
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? 20,
    storeExtIds: [opts.store ?? DEFAULT_STORE],
    includeWholesale: false,
    sortBy: "default",
  };
  return api("/products/raw-search/?with_detail=true", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as Promise<SearchResponse>;
}

const getCategories = () => api("/categories/") as Promise<Category[]>;
const getStores = () => api("/stores/") as Promise<Store[]>;

// Authenticated endpoints
const getCart = async () => api("/smart-checkouts/default/", { headers: await authHeaders() });

async function addToCart(sku: string, quantity = 1) {
  return api("/smart-checkouts/default/lines/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ lines: [{ quantity, sku, source: "categories" }], force: false }),
  });
}

async function getOrders(opts: { limit?: number; offset?: number } = {}) {
  const limit = opts.limit ?? 15;
  const offset = opts.offset ?? 0;
  return api(`/orders/?limit=${limit}&offset=${offset}`, { headers: await authHeaders() });
}

const getOrder = async (id: string) =>
  api(`/orders/${id}/`, { headers: await authHeaders() });

const getReceipt = async (id: string) =>
  api(`/orders/${id}/receipt/`, { headers: await authHeaders() });

const getPaymentReceipt = async (id: string) =>
  api(`/orders/${id}/payment-receipt/`, { headers: await authHeaders() });

async function getHealthPoints(year?: number, month?: number) {
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;
  return api(`/health-carts/points/summary/?year=${y}&month=${m}`, { headers: await authHeaders() });
}

const getOrderHealthPoints = async (id: string) =>
  api(`/health-carts/points/orders/${id}/`, { headers: await authHeaders() });

const getPaymentCards = async () =>
  api("/payments/cards/v2/", { headers: await authHeaders() });

const getRecommendations = async () =>
  api("/products/recommendations/personalized-lists/", { headers: await authHeaders() });

// Login flow

const COGNITO_URL = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;
const COGNITO_HEADERS = {
  "content-type": "application/x-amz-json-1.1",
};

async function cognitoCall(target: string, body: unknown) {
  const resp = await fetch(COGNITO_URL, {
    method: "POST",
    headers: { ...COGNITO_HEADERS, "x-amz-target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Cognito ${target}: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function login(kennitala: string): Promise<void> {
  const initData = await cognitoCall("InitiateAuth", {
    AuthFlow: "CUSTOM_AUTH",
    AuthParameters: { USERNAME: kennitala },
    ClientId: COGNITO_CLIENT_ID,
  });

  const code = initData.ChallengeParameters?.code;
  console.log(`\n  Auðkenni code: ${code}\n`);
  console.log("  Confirm on your device...\n");

  let session = initData.Session;
  for (let i = 0; i < 60; i++) {
    const data = await cognitoCall("RespondToAuthChallenge", {
      ChallengeName: "CUSTOM_CHALLENGE",
      ChallengeResponses: { USERNAME: kennitala, ANSWER: "answer" },
      Session: session,
      ClientId: COGNITO_CLIENT_ID,
    });

    if (data.AuthenticationResult) {
      const cookies: CookieEntry[] = [
        { name: "id_token", value: data.AuthenticationResult.IdToken, domain: "kronan.is" },
        { name: "refresh_token", value: data.AuthenticationResult.RefreshToken, domain: "kronan.is" },
      ];
      writeCookies(cookies);
      console.log("  Logged in!\n");
      return;
    }

    if (data.ChallengeName === "CUSTOM_CHALLENGE") {
      session = data.Session;
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    throw new Error(`Unexpected auth response: ${JSON.stringify(data).substring(0, 200)}`);
  }
  throw new Error("Login timed out");
}

// Group context

function readGroupId(): number | null {
  if (process.env.KRONAN_GROUP) return parseInt(process.env.KRONAN_GROUP, 10);
  try {
    const id = require("fs").readFileSync(GROUP_PATH, "utf-8").trim();
    return id ? parseInt(id, 10) : null;
  } catch {
    return null;
  }
}

function writeGroupId(id: number) {
  require("fs").writeFileSync(GROUP_PATH, String(id) + "\n");
}

// Profile & Groups
const getMe = async () => api("/users/me/", { headers: await authHeaders() });

const getGroups = async () =>
  api("/customer_groups/", { headers: await authHeaders() }) as Promise<
    {
      id: number;
      name: string;
      type: string;
      image: string | null;
      mostLikelyPickingStoreId: number;
      mostLikelyPickingStoreIds: number[];
      groupId: string;
      defaultShippingAddress: number;
      communityCode: string | null;
      nextOrderFreeShipping: boolean;
      hasWholesaleSelection: boolean;
      bagless: boolean;
      users: {
        id: number;
        firstName: string;
        email: string;
        avatar: string | null;
        isAdmin: boolean;
      }[];
    }[]
  >;

// --- Output helpers ---

function printProduct(p: Product) {
  const sale = p.detail?.onSale
    ? ` (${p.detail.discountPercent}% off -> ${p.detail.discountedPrice} kr.)`
    : "";
  const shortage = p.temporaryShortage ? " [OUT OF STOCK]" : "";
  console.log(`  ${p.sku}  ${p.name}  ${p.price} kr.${sale}${shortage}`);
  if (p.priceInfo) console.log(`         ${p.priceInfo}`);
}

function printCategory(cat: Category, indent = 0) {
  console.log(`${"  ".repeat(indent)}${cat.slug}  ${cat.name}`);
  if (cat.children) {
    for (const child of cat.children) printCategory(child, indent + 1);
  }
}

// --- CLI ---

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "search":
  case "s": {
    const query = args.join(" ");
    if (!query) {
      console.error("Usage: klownan search <query>");
      process.exit(1);
    }
    const data = await search(query);
    console.log(`${data.count} results (page ${data.page}/${data.pageCount}):\n`);
    for (const p of data.results.hits) printProduct(p);
    break;
  }

  case "categories":
  case "cat": {
    const cats = await getCategories();
    for (const cat of cats) printCategory(cat);
    break;
  }

  case "stores": {
    const stores = await getStores();
    for (const s of stores) {
      if (!s.isWholesale) {
        console.log(
          `  ${s.extId.padEnd(4)} ${s.displayName || s.name}  ${s.address}, ${s.postalCode} ${s.city}  pickup:${s.hasPickup} scan:${s.isScanNGo}`
        );
      }
    }
    break;
  }

  case "cart": {
    const cart = await getCart();
    console.log(JSON.stringify(cart, null, 2));
    break;
  }

  case "add": {
    const sku = args[0];
    const qty = parseInt(args[1] || "1", 10);
    if (!sku) {
      console.error("Usage: klownan add <sku> [quantity]");
      process.exit(1);
    }
    const result = await addToCart(sku, qty);
    console.log("Added to cart:", JSON.stringify(result, null, 2));
    break;
  }

  case "orders": {
    const limit = args[0] ? parseInt(args[0], 10) : 15;
    const offset = args[1] ? parseInt(args[1], 10) : 0;
    const data = (await getOrders({ limit, offset })) as {
      count: number;
      results: {
        token: string;
        displayDate: string;
        status: string;
        totalNetAmount: string;
        lines: { productName: string; quantity: number; unitPriceNetAmount: string }[];
        store?: { name: string };
        user?: { name: string };
      }[];
    };
    console.log(`${data.count} total orders (showing ${offset + 1}-${offset + data.results.length}):\n`);
    for (const o of data.results) {
      const date = new Date(o.displayDate).toLocaleDateString("is-IS");
      const total = parseFloat(o.totalNetAmount).toLocaleString("is-IS");
      const items = o.lines.length;
      const store = o.store?.name ?? "";
      const who = o.user?.name ?? "";
      console.log(`  ${date}  ${total} kr.  ${items} items  ${store}  ${who}  [${o.token}]`);
    }
    break;
  }

  case "order": {
    const id = args[0];
    if (!id) {
      console.error("Usage: klownan order <order-id>");
      process.exit(1);
    }
    const order = await getOrder(id);
    console.log(JSON.stringify(order, null, 2));
    break;
  }

  case "receipt": {
    const id = args[0];
    if (!id) {
      console.error("Usage: klownan receipt <order-id>");
      process.exit(1);
    }
    const receipt = await getReceipt(id);
    console.log(JSON.stringify(receipt, null, 2));
    break;
  }

  case "health": {
    const points = await getHealthPoints();
    console.log(JSON.stringify(points, null, 2));
    break;
  }

  case "cards": {
    const cards = await getPaymentCards();
    console.log(JSON.stringify(cards, null, 2));
    break;
  }

  case "recommendations":
  case "rec": {
    const recs = await getRecommendations();
    console.log(JSON.stringify(recs, null, 2));
    break;
  }

  case "login": {
    const kt = args[0];
    if (!kt) {
      console.error("Usage: klownan login <kennitala>");
      process.exit(1);
    }
    await login(kt);
    break;
  }

  case "me": {
    const me = (await getMe()) as Record<string, unknown>;
    console.log(`${me.name}`);
    console.log(`  email: ${me.email}`);
    console.log(`  phone: ${me.phoneNumber}`);
    console.log(`  store: ${me.mostLikelyPickingStoreId}`);
    console.log(`  free shipping next: ${me.nextOrderFreeShipping}`);
    console.log(`  bagless: ${me.bagless}`);
    break;
  }

  case "groups": {
    const groups = await getGroups();
    const activeId = readGroupId();
    for (const g of groups) {
      const marker = g.id === activeId ? " *" : "";
      console.log(`  ${g.id}  ${g.name}  (${g.type})${marker}`);
      for (const u of g.users) {
        const role = u.isAdmin ? "admin" : "member";
        console.log(`       ${u.firstName}  ${u.email}  ${role}`);
      }
    }
    if (activeId) {
      console.log(`\nActive group: ${activeId}`);
    } else {
      console.log(`\nNo active group. Use "klownan use <name>" to set one.`);
    }
    break;
  }

  case "use": {
    const query = args.join(" ").toLowerCase();
    if (!query) {
      const activeId = readGroupId();
      if (activeId) {
        const groups = await getGroups();
        const active = groups.find((g) => g.id === activeId);
        console.log(`Active: ${active?.name ?? activeId} (${activeId})`);
      } else {
        console.log("No active group. Usage: klownan use <name or id>");
      }
      break;
    }
    const groups = await getGroups();
    const norm = (s: string) =>
      s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const q = norm(query);
    const match =
      groups.find((g) => String(g.id) === query) ||
      groups.find((g) => norm(g.name) === q) ||
      groups.find((g) => norm(g.name).includes(q));
    if (!match) {
      console.error(`No group matching "${query}". Available:`);
      for (const g of groups) console.error(`  ${g.id}  ${g.name}`);
      process.exit(1);
    }
    writeGroupId(match.id);
    console.log(`Switched to: ${match.name} (${match.id})`);
    break;
  }

  default:
    console.log(`klownan - Krónan grocery CLI

Public:
  klownan search <query>          Search products
  klownan categories              List all categories
  klownan stores                  List stores

Authenticated:
  klownan login <kennitala>        Login via Auðkenni
  klownan me                      Your profile
  klownan groups                  List groups (households/companies)
  klownan use <name|id>           Switch active group
  klownan cart                    View cart
  klownan add <sku> [qty]         Add to cart
  klownan orders [limit] [offset] List orders (paginated, default: 15)
  klownan order <id>              Order detail
  klownan receipt <id>            Order receipt
  klownan health                  Heillakarfa points summary
  klownan cards                   Payment cards
  klownan recommendations         Personalized product recommendations

Environment:
  KRONAN_TOKEN    Override auth (optional)
  KRONAN_GROUP    Override active group (optional)`);
}
