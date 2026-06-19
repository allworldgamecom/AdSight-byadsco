/**
 * Path 2B — token-free write router (todo #7).
 *
 * byadsco в 2B НЕ держит Meta-токен (INV-A: токен off-box, только в gateway .env.money).
 * Все write проходят через gateway, который держит токен и применяет HITL/budget/idempotency.
 *
 * Этот модуль — РОУТЕР, не enforcement. Он лишь решает, в КАКОЙ эндпоинт gateway послать
 * сырой Graph write:
 *   - money-significant (budget / status=ACTIVE / money-create) → POST /v1/act (типизированный action)
 *   - non-money (creative / audience / pixel / comment / report / ...) → POST /v1/meta (raw pass)
 *
 * АВТОРИТЕТНЫЙ носитель money-инварианта — gateway (INV-C, один носitель):
 *   - /v1/meta хард-реджектит budget/ACTIVE (field-guard → 502), значит ошибочно
 *     классифицированный money НЕ протечёт как non-money.
 *   - /v1/act требует HITL-токен для активации/масштабирования.
 * Ошибки локального классификатора fail-safe (в сторону DENY/HITL), не в сторону leak.
 *
 * Активируется флагом ADSIGHT_GW_MODE=token-free. По умолчанию (direct) НЕ используется —
 * поведение byadsco не меняется (аддитивно, lock #3).
 */

import { logger } from "../utils/logger.js";

export class ReadDisabledError extends Error {
  readonly code = "READ_DISABLED";
  constructor(path: string) {
    super(
      `token-free режим: прямой Graph-read запрещён (read=hashcott). path=${path}`,
    );
    this.name = "ReadDisabledError";
  }
}

export class MediaUploadNotRoutedError extends Error {
  readonly code = "MEDIA_UPLOAD_NOT_ROUTED";
  constructor(path: string) {
    super(
      `token-free режим v1: media-upload (multipart) не маршрутизируется через gateway. ` +
        `path=${path}. Бинарный passthrough — отдельный PR (v2).`,
    );
    this.name = "MediaUploadNotRoutedError";
  }
}

export class GatewayWriteError extends Error {
  readonly code = "GATEWAY_WRITE_ERROR";
  readonly status: number;
  readonly enforced?: string;
  readonly requestId?: string;
  constructor(status: number, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    super(
      `gateway отклонил write: HTTP ${status} ` +
        `${b.enforced ? `[${String(b.enforced)}] ` : ""}${b.error ? String(b.error) : ""}`,
    );
    this.name = "GatewayWriteError";
    this.status = status;
    this.enforced = b.enforced ? String(b.enforced) : undefined;
    this.requestId = b.requestId ? String(b.requestId) : undefined;
  }
}

type RawFields = Record<string, unknown>;

export interface GatewayClientConfig {
  url: string; // ADSIGHT_GW_URL, напр. http://127.0.0.1:8787
  apiKey: string; // ADSIGHT_GW_API_KEY (общий MCP_API_KEY gateway, X-AdSight-Key)
  session: string; // ADSIGHT_GW_SESSION, напр. S-traffic_specialist (role-gate M1)
  timeoutMs?: number;
}

// ── money-классификатор (консервативный, fail-safe) ──────────────────────
//
// Зеркалит gateway _MONEY_KEYS/суффиксы НА СТОРОНЕ РОУТЕРА только для ВЫБОРА
// эндпоинта. Это НЕ дублирование enforcement: даже если тут ошибёмся, gateway
// независимо реджектит money на /v1/meta. Список намеренно ШИРЕ (over-route в money безопаснее).
const MONEY_KEY_SUFFIXES = [
  "budget",
  "budget_cents",
  "bid",
  "bid_amount",
  "spend_cap",
  "daily_spend_cap",
  "lifetime_budget",
  "bid_constraints",
];
// AUDIT-3 C5: control-ключи, ломающие path-изоляцию (Graph исполняет глобально). Зеркало gateway.
const CONTROL_KEYS = new Set(["batch", "ids", "include_headers", "asset_feed_spec_overrides"]);
// AUDIT-3 C4: structured-поля, которые Meta принимает как вложенный JSON (строкой/dict). Зеркало gateway.
const STRUCTURED_JSON_FIELDS = new Set([
  "object_story_spec",
  "asset_feed_spec",
  "promoted_object",
  "targeting",
  "bid_info",
  "degrees_of_freedom_spec",
  "link_data",
]);
// AUDIT-3: активационные статусы = начало траты (зеркало gateway: ACTIVE + UNPAUSED).
const ACTIVE_STATUSES = new Set(["ACTIVE", "UNPAUSED"]);
const MONEY_KEYS = new Set([
  "budget",
  "daily_budget",
  "lifetime_budget",
  "budget_cents",
  "daily_budget_cents",
  "lifetime_budget_cents",
  "bid",
  "bid_amount",
  "bid_strategy",
  "bid_constraints",
  "bid_info",
  "bid_type",
  "bid_adjustments",
  "pacing_type",
  "budget_rebalance_flag",
  "spend_cap",
  "daily_spend_cap",
  "lifetime_spend_cap",
  "min_spend_target",
  "daily_min_spend_target",
  "lifetime_min_spend_target",
]);

function isMoneyKey(k: string): boolean {
  const kl = k.toLowerCase();
  if (MONEY_KEYS.has(kl)) return true;
  for (const suf of MONEY_KEY_SUFFIXES) {
    if (kl === suf || kl.endsWith("_" + suf)) return true;
  }
  return kl.includes("spend_cap") || kl.endsWith("_bid") || kl.endsWith("_budget");
}

/** Нормализованная проверка активационного статуса: trim+upper (AUDIT-3 whitespace-bypass). */
function isActiveStatus(v: unknown): boolean {
  return ACTIVE_STATUSES.has(String(v).trim().toUpperCase());
}

// AUDIT-3 MAJOR-A: РЕКУРСИВНЫЙ money-классификатор, зеркалит gateway _has_money_field
// (path2b/gateway/backends.py:332-356). Цель — выбор эндпоинта; даже при ошибке gateway
// независимо реджектит money на /v1/meta. fail-CLOSED: нераспарсенный structured-blob → money.
function hasMoneyField(fields: unknown): boolean {
  if (fields !== null && typeof fields === "object" && !Array.isArray(fields)) {
    for (const [k, v0] of Object.entries(fields as RawFields)) {
      const kl = k.toLowerCase();
      if (CONTROL_KEYS.has(kl)) return true; // C5
      if (isMoneyKey(kl)) return true; // C3
      if (kl === "status" && isActiveStatus(v0)) return true; // активация (trim+ACTIVE/UNPAUSED)
      let v: unknown = v0;
      // C4: structured-поле строкой → парсим; не распарсилось → fail-closed (money).
      if (typeof v === "string" && STRUCTURED_JSON_FIELDS.has(kl)) {
        try {
          v = JSON.parse(v);
        } catch {
          return true;
        }
      }
      if (hasMoneyField(v)) return true; // рекурсия в dict/list
    }
    return false;
  }
  if (Array.isArray(fields)) {
    return fields.some((x) => hasMoneyField(x));
  }
  return false;
}

// money-create paths: POST /act_X/{campaigns|adsets|ads} всегда money (создаёт платящий объект)
const RE_ACCT = /^\/?act_[A-Za-z0-9]+\/(campaigns|adsets|ads)$/;
// account spend_cap: POST /act_X {spend_cap}
const RE_ACCT_ROOT = /^\/?act_[A-Za-z0-9]+$/;
// node-path: POST /{id} (update/activate/pause) — money ТОЛЬКО если несёт money-field/ACTIVE
const RE_NODE = /^\/?[A-Za-z0-9_]+$/;

interface ActRequest {
  action: string;
  target: string;
  costCents: number;
  body: RawFields;
}

/** Первый сегмент пути (act_<id> или id узла) для target. */
function firstSeg(path: string): string {
  const clean = path.replace(/^\/+/, "");
  return clean.split("/")[0] ?? clean;
}

// AUDIT-3 MAJOR-C: МАКСИМУМ по всем присутствующим budget-ключам (не первый-match).
// costCents — лишь подсказка; авторитетный резерв считает gateway. Но не занижаем хинт.
function budgetCents(fields: RawFields): number {
  let max = 0;
  for (const key of [
    "daily_budget",
    "daily_budget_cents",
    "lifetime_budget",
    "lifetime_budget_cents",
    "budget",
    "budget_cents",
    "spend_cap",
    "spend_cap_cents",
  ]) {
    const v = fields[key];
    if (v !== undefined && v !== null) {
      const n = Number(v);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return Math.round(max);
}

// AUDIT-3 MAJOR-E: gateway publish_campaign/publish_adset/activate_* резервируют по
// daily_budget_cents/dailyBudgetCents (server.py:_reserve_cents), но byadsco-тулы шлют
// daily_budget (string-cents). Добавляем алиас *_cents в body, чтобы gateway-резерв нашёл
// сумму и не вернул _RESERVE_DENY(402). Аддитивно: исходные ключи остаются для backend.
function withReserveAliases(fields: RawFields): RawFields {
  const out: RawFields = { ...fields };
  const aliasOf = (src: string, dst: string) => {
    if (out[dst] === undefined && out[src] !== undefined && out[src] !== null) {
      const n = Number(out[src]);
      if (Number.isFinite(n)) out[dst] = Math.round(n);
    }
  };
  aliasOf("daily_budget", "daily_budget_cents");
  aliasOf("lifetime_budget", "lifetime_budget_cents");
  aliasOf("spend_cap", "spend_cap_cents");
  return out;
}

/**
 * Отобразить money-write (method, path, fields) → типизированный gateway action.
 * Возвращает null, если money, но НЕ маппится в известный action → caller DENY локально
 * (НЕ слать raw money в /v1/meta).
 *
 * Покрывает 11 known actions gateway. activate_* и deferred-spend gateway сам хард-реджектит
 * (мы их даже не пытаемся скрыть — пусть gateway вернёт явный 403/502).
 */
export function mapMoneyAction(
  method: string,
  path: string,
  fields: RawFields,
): ActRequest | null {
  const m = method.toUpperCase();
  const p = path.startsWith("/") ? path : `/${path}`;
  // AUDIT-3: trim+upper для статуса (whitespace-bypass " ACTIVE " → ACTIVE).
  const status = String(fields.status ?? "").trim().toUpperCase();
  // AUDIT-3 MAJOR-E: body с алиасами *_cents для gateway-резерва (publish/activate/scale).
  const body = withReserveAliases(fields);

  // DELETE на узле — destructive money-объект (campaign/adset/ad). gateway v1 знает только pause_*.
  // delete_* НЕ в _KNOWN_ACTIONS → не маппим (pause предпочтительнее). Вернём null → DENY.
  if (m === "DELETE") return null;

  // POST /act_X/campaigns → publish_campaign
  if (RE_ACCT.test(p)) {
    const coll = p.match(RE_ACCT)![1];
    if (coll === "campaigns")
      return { action: "publish_campaign", target: firstSeg(p), costCents: budgetCents(fields), body };
    if (coll === "adsets")
      return { action: "publish_adset", target: firstSeg(p), costCents: budgetCents(fields), body };
    if (coll === "ads")
      // создание ad: money если внутри платящего adset. gateway не имеет publish_ad money-резерва
      // в v1 _KNOWN_ACTIONS (нет publish_ad) → null → DENY (создаётся через verified-flow, отд. PR).
      return null;
  }

  // POST /act_X {spend_cap} → set_spend_cap
  if (RE_ACCT_ROOT.test(p) && fields.spend_cap !== undefined) {
    return { action: "set_spend_cap", target: firstSeg(p), costCents: budgetCents(fields), body };
  }

  // POST /{id} с money-полем/ACTIVE → update/scale/activate/pause по содержимому
  if (RE_NODE.test(p)) {
    const id = firstSeg(p);
    // pause: status=PAUSED — НЕ money (останавливает трату), но идёт типизированно для аудита.
    if (status === "PAUSED") {
      // pause_campaign/adset/ad — тип объекта неизвестен из id (opaque node-id).
      // Дефолт pause_campaign с campaign_id=id. pause обратим и НЕ тратит → spend-safe независимо
      // от типа. v2: прокидывать тип объекта от caller → pause_adset/pause_ad. (кладём ТОЛЬКО campaign_id.)
      return {
        action: "pause_campaign",
        target: id,
        costCents: 0,
        body: { ...body, campaign_id: id },
      };
    }
    if (status === "ACTIVE") {
      // activate_* — gateway хард-реджектит в v1 (deferred-spend). Шлём activate_campaign,
      // gateway вернёт явный 403/502. НЕ слать как non-money (это money/ACTIVE).
      return {
        action: "activate_campaign",
        target: id,
        costCents: budgetCents(fields),
        body: { ...body, campaign_id: id },
      };
    }
    // budget-update без status → scale. gateway: scale_budget(campaign)/scale_adset_budget(adset).
    if (hasMoneyField(fields)) {
      // тип объекта неизвестен — дефолт scale_budget(campaign). gateway scale_budget ждёт
      // campaign_id и применит daily_budget на узел id. (кладём ТОЛЬКО campaign_id; v2: тип от caller.)
      return {
        action: "scale_budget",
        target: id,
        costCents: budgetCents(fields),
        body: { ...body, campaign_id: id },
      };
    }
  }

  // money по флагу, но путь не распознан → null → DENY (fail-safe).
  return null;
}

export class GatewayWriteClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly session: string;
  private readonly timeoutMs: number;

  constructor(cfg: GatewayClientConfig) {
    this.url = validateGatewayUrl(cfg.url);
    this.apiKey = cfg.apiKey;
    this.session = cfg.session;
    this.timeoutMs = cfg.timeoutMs ?? 30000;
  }

  /** Главный вход: маршрутизировать сырой write в gateway. Возвращает тело ответа gateway. */
  async route<T>(method: string, path: string, fields: RawFields): Promise<T> {
    const m = method.toUpperCase();
    if (m === "GET") {
      throw new ReadDisabledError(path);
    }
    if (m !== "POST" && m !== "DELETE") {
      throw new GatewayWriteError(400, { error: `метод '${m}' не поддержан роутером`, enforced: "badRequest" });
    }

    const money = m === "DELETE" || RE_ACCT.test(path.startsWith("/") ? path : `/${path}`) || hasMoneyField(fields);

    if (money) {
      const act = mapMoneyAction(m, path, fields);
      if (!act) {
        // money, но не маппится → локальный DENY (НЕ slать raw money в non-money pass)
        throw new GatewayWriteError(403, {
          error: `money-write не маппится в известный gateway-action: ${m} ${path}`,
          enforced: "unmappedMoney",
        });
      }
      return this.postAct<T>(act);
    }
    return this.postMeta<T>(m, path, fields);
  }

  private async postAct<T>(act: ActRequest): Promise<T> {
    return this.send<T>("/v1/act", {
      action: act.action,
      target: act.target,
      costCents: act.costCents,
      body: act.body,
    });
  }

  private async postMeta<T>(method: string, path: string, fields: RawFields): Promise<T> {
    return this.send<T>("/v1/meta", {
      method,
      path: path.startsWith("/") ? path : `/${path}`,
      fields,
    });
  }

  private async send<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.url}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AdSight-Key": this.apiKey,
          "X-AdSight-Session": this.session,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = (await resp.json().catch(() => ({}))) as unknown;
      if (!resp.ok) {
        logger.warn(
          { endpoint, status: resp.status, enforced: (body as Record<string, unknown>)?.enforced },
          "gateway отклонил write",
        );
        throw new GatewayWriteError(resp.status, body);
      }
      return body as T;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new GatewayWriteError(504, { error: `gateway timeout ${this.timeoutMs}ms`, enforced: "timeout" });
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ── singleton-фабрика (mirrors metaApiClient pattern) ────────────────────
let _gwClient: GatewayWriteClient | null = null;

// AUDIT-3 MINOR-1: ADSIGHT_GW_URL валидация — только loopback http ИЛИ https; никакого
// query/fragment/userinfo (иначе плохой env может утечь X-AdSight-Key на чужой хост).
export function validateGatewayUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`ADSIGHT_GW_URL не URL: ${raw}`);
  }
  if (u.username || u.password) {
    throw new Error("ADSIGHT_GW_URL не должен содержать userinfo (user:pass@).");
  }
  if (u.search || u.hash) {
    throw new Error("ADSIGHT_GW_URL не должен содержать query/fragment.");
  }
  const isLoopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol === "http:") {
    if (!isLoopback) {
      throw new Error(`ADSIGHT_GW_URL http:// разрешён ТОЛЬКО на loopback, не ${u.hostname}.`);
    }
  } else if (u.protocol !== "https:") {
    throw new Error(`ADSIGHT_GW_URL: недопустимый протокол ${u.protocol} (только http loopback / https).`);
  }
  return raw.replace(/\/+$/, "");
}

// AUDIT-3 MAJOR-B: fail-CLOSED парсинг режима. trim, строгий enum, throw на неизвестном
// непустом значении (иначе "token-free " тихо → direct Graph = token-leak risk).
function parseGwMode(): "direct" | "token-free" {
  const raw = process.env.ADSIGHT_GW_MODE;
  if (raw === undefined || raw === "") return "direct";
  const mode = raw.trim().toLowerCase();
  if (mode === "direct" || mode === "token-free") return mode;
  throw new Error(
    `ADSIGHT_GW_MODE='${raw}' недопустим: только 'direct' или 'token-free' (fail-closed).`,
  );
}

export function isTokenFreeMode(): boolean {
  return parseGwMode() === "token-free";
}

export function getGatewayWriteClient(): GatewayWriteClient {
  if (_gwClient) return _gwClient;
  const url = process.env.ADSIGHT_GW_URL;
  const apiKey = process.env.ADSIGHT_GW_API_KEY;
  const session = process.env.ADSIGHT_GW_SESSION;
  if (!url || !apiKey || !session) {
    throw new Error(
      "token-free режим требует ADSIGHT_GW_URL, ADSIGHT_GW_API_KEY, ADSIGHT_GW_SESSION в env.",
    );
  }
  _gwClient = new GatewayWriteClient({
    url,
    apiKey,
    session,
    timeoutMs: process.env.ADSIGHT_GW_TIMEOUT_MS ? Number(process.env.ADSIGHT_GW_TIMEOUT_MS) : undefined,
  });
  return _gwClient;
}

export function resetGatewayWriteClientForTests(): void {
  _gwClient = null;
}
