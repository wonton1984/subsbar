// config v1 校验与规范化（contracts §4）。封闭字段：未知字段拒绝；optional 省略按默认。
import { SOURCE_KINDS, safeText } from "../defs.mjs";

const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;

function isPlainObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

function reject(msg) { const e = new Error(msg); e.code = "invalid-config"; throw e; }

function checkUnknown(obj, allowed, where) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) reject(`${where}: 未知字段 ${k}`);
}

const RUNTIME_DEFAULTS = { nodePath: "auto", refreshIntervalSeconds: 300, timeoutSeconds: 15, maxConcurrency: 3 };
const PRIVACY_DEFAULTS = { allowBrowserDiscovery: false, diagnostics: "local-redacted" };
const UI_DEFAULTS = {
  locale: "system", appearance: "system", density: "compact", overviewMode: "cards",
  selectedProvider: null, showMenuBarPercent: true, showAccountLabel: false,
  providerOrder: [], cards: {}, menuBarProviders: null, menuBarLimit: 1,
};
/** 读入接受、写出剥离（rev7：菜单栏改为独立槽位，不再写 menuBarMode/pinnedMetrics）。 */
const UI_LEGACY_KEYS = ["menuBarMode", "pinnedMetrics"];
const COMPAT_DEFAULTS = { pi: { enabled: false, agentDir: undefined }, legacyCache: { import: "never", path: undefined } };

const ENUMS = {
  "ui.locale": ["system", "zh-Hans", "en"],
  "ui.appearance": ["system", "light", "dark"],
  "ui.density": ["compact", "comfortable"],
  "ui.overviewMode": ["cards", "single"],
  "ui.menuBarMode": ["single-pie", "pinned"],
  "privacy.diagnostics": ["off", "local-redacted"],
  "compatibility.legacyCache.import": ["never", "manual"],
  "Profile.discovery": ["auto", "only"],
};

function enumCheck(where, value, key) {
  if (!ENUMS[key].includes(value)) reject(`${where}: 非法枚举 ${value}`);
}

function intRange(where, v, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) reject(`${where}: 需要整数 ${lo}..${hi}`);
}

/** SourceSpec 校验：kind 专属字段封闭（contracts §4.1 表）。 */
function validateSourceSpec(raw, where) {
  if (!isPlainObject(raw)) reject(`${where}: source 必须是对象`);
  for (const k of ["id", "kind", "reader"]) {
    if (typeof raw[k] !== "string" || !raw[k]) reject(`${where}: 缺 ${k}`);
  }
  if (!ID_RE.test(raw.id)) reject(`${where}: 非法 id`);
  if (!SOURCE_KINDS.includes(raw.kind)) reject(`${where}: 非法 kind`);
  const common = ["id", "kind", "reader", "purpose", "envName", "path", "service", "account", "browserProfile", "origin", "executablePath", "keychainPath"];
  checkUnknown(raw, common, where);
  if (raw.purpose !== undefined && !["primary", "management"].includes(raw.purpose)) reject(`${where}: 非法 purpose`);
  const kindAllowed = {
    env: ["envName"], file: ["path", "account", "keychainPath"], keychain: ["service", "account", "keychainPath"], cli: ["executablePath"],
    pi: ["path"], browser: ["browserProfile", "origin"], "local-api": [],
  }[raw.kind];
  for (const k of Object.keys(raw)) {
    if (!["id", "kind", "reader", "purpose"].includes(k) && !kindAllowed.includes(k)) {
      reject(`${where}: kind=${raw.kind} 不允许字段 ${k}`);
    }
  }
  if (raw.kind === "browser" && (typeof raw.browserProfile !== "string" || typeof raw.origin !== "string")) {
    reject(`${where}: browser 来源必须带 browserProfile 与 origin`);
  }
  if (raw.keychainPath !== undefined) {
    if (typeof raw.keychainPath !== "string" || !(raw.keychainPath.startsWith("/") || raw.keychainPath.startsWith("~/"))) {
      reject(`${where}: keychainPath 必须是绝对路径或 ~/`);
    }
  }
  return raw;
}

function validateProfile(raw, where) {
  if (!isPlainObject(raw)) reject(`${where}: profile 必须是对象`);
  checkUnknown(raw, ["id", "label", "region", "organizationId", "expectedAccount", "discovery",
    "allowKeychain", "allowBrowser", "allowLocalApi", "sources"], where);
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) reject(`${where}: 非法 profile id`);
  const p = {
    id: raw.id,
    discovery: raw.discovery ?? "auto",
    allowKeychain: raw.allowKeychain ?? false,
    allowBrowser: raw.allowBrowser ?? false,
    allowLocalApi: raw.allowLocalApi ?? false,
    sources: [],
  };
  enumCheck(where, p.discovery, "Profile.discovery");
  if (raw.label !== undefined) p.label = safeText(raw.label, 64);
  if (raw.region !== undefined) { if (typeof raw.region !== "string" || !raw.region) reject(`${where}: region`); p.region = safeText(raw.region, 32); }
  if (raw.organizationId !== undefined) { if (typeof raw.organizationId !== "string") reject(`${where}: organizationId`); p.organizationId = safeText(raw.organizationId, 128); }
  if (raw.expectedAccount !== undefined) { if (typeof raw.expectedAccount !== "string") reject(`${where}: expectedAccount`); p.expectedAccount = safeText(raw.expectedAccount, 128); }
  if (!Array.isArray(raw.sources ?? [])) reject(`${where}: sources 必须是数组`);
  p.sources = (raw.sources ?? []).map((s, i) => validateSourceSpec(s, `${where}.sources[${i}]`));
  if (p.discovery === "only" && p.sources.length === 0) reject(`${where}: discovery=only 且 sources 为空`);
  return p;
}

function validateProvider(raw, where) {
  if (!isPlainObject(raw)) reject(`${where}: provider 必须是对象`);
  checkUnknown(raw, ["enabled", "dataSource", "allowCommunityEndpoints", "refreshIntervalSeconds", "activeProfile", "profiles"], where);
  const out = {
    enabled: raw.enabled ?? false,
    dataSource: raw.dataSource ?? "auto",
    allowCommunityEndpoints: raw.allowCommunityEndpoints ?? false,
    profiles: [],
  };
  if (raw.refreshIntervalSeconds !== undefined) intRange(`${where}.refreshIntervalSeconds`, raw.refreshIntervalSeconds, 60, 86400), out.refreshIntervalSeconds = raw.refreshIntervalSeconds;
  if (!Array.isArray(raw.profiles ?? [])) reject(`${where}: profiles 必须是数组`);
  const seen = new Set();
  out.profiles = (raw.profiles ?? []).map((pr, i) => {
    const p = validateProfile(pr, `${where}.profiles[${i}]`);
    if (seen.has(p.id)) reject(`${where}: 重复 profile id ${p.id}`);
    seen.add(p.id);
    return p;
  });
  if (raw.activeProfile !== undefined) {
    if (typeof raw.activeProfile !== "string") reject(`${where}: activeProfile`);
    out.activeProfile = raw.activeProfile;
  }
  if (out.enabled && !out.activeProfile) reject(`${where}: enabled 必须有 activeProfile`);
  if (out.enabled && out.activeProfile && !seen.has(out.activeProfile)) reject(`${where}: activeProfile 引用不存在`);
  return out;
}

function validatePin(raw, where) {
  if (!isPlainObject(raw)) reject(`${where}: pin 必须是对象`);
  checkUnknown(raw, ["providerId", "profileId", "metricId", "field", "style"], where);
  for (const k of ["providerId", "profileId", "metricId"]) {
    if (typeof raw[k] !== "string" || !raw[k]) reject(`${where}: 缺 ${k}`);
  }
  if (!["remaining-percent", "used-percent", "remaining", "used", "value"].includes(raw.field)) reject(`${where}: 非法 field`);
  if (raw.style !== undefined && !["text", "mini-bar"].includes(raw.style)) reject(`${where}: 非法 style`);
  return { ...raw, style: raw.style ?? "text" };
}

function uniqueProviderIds(ids, where) {
  if (!Array.isArray(ids)) reject(where);
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (typeof id !== "string" || !ID_RE.test(id)) reject(`${where}.id`);
    if (seen.has(id)) reject(`${where} 重复`);
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 菜单栏字段：新字段优先；否则 menuBarMode=pinned 从 pins 去重迁移；无旧字段 → null/1。
 * 旧字段不进入返回值（写出剥离）。
 */
function migrateMenuBar(rui) {
  if (rui.menuBarLimit !== undefined) intRange("ui.menuBarLimit", rui.menuBarLimit, 0, 4);
  const hasNew = Object.prototype.hasOwnProperty.call(rui, "menuBarProviders");
  if (hasNew) {
    const raw = rui.menuBarProviders;
    if (raw !== null && !Array.isArray(raw)) reject("ui.menuBarProviders");
    const providers = raw === null ? null : uniqueProviderIds(raw, "ui.menuBarProviders");
    const limit = rui.menuBarLimit ?? UI_DEFAULTS.menuBarLimit;
    if (providers !== null && providers.length > limit) reject("ui.menuBarProviders");
    return { menuBarProviders: providers, menuBarLimit: limit };
  }
  if (rui.menuBarMode === "pinned") {
    const pins = Array.isArray(rui.pinnedMetrics) ? rui.pinnedMetrics : [];
    const ids = [];
    const seen = new Set();
    for (const pin of pins) {
      const id = pin?.providerId;
      if (typeof id === "string" && ID_RE.test(id) && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    const limit = rui.menuBarLimit ?? (pins.length === 0 ? 1 : Math.min(pins.length, 4));
    if (ids.length > limit) reject("ui.menuBarProviders");
    return { menuBarProviders: ids, menuBarLimit: limit };
  }
  return { menuBarProviders: null, menuBarLimit: rui.menuBarLimit ?? UI_DEFAULTS.menuBarLimit };
}

/**
 * 校验并规范化 config 根对象。未知字段/类型错误抛 {code:"invalid-config"}。
 * 返回带默认补全的规范化副本（不修改输入）。
 */
export function validateConfig(raw) {
  if (!isPlainObject(raw)) reject("config 根必须是对象");
  checkUnknown(raw, ["schemaVersion", "revision", "runtime", "privacy", "ui", "providers", "compatibility"], "root");
  if (raw.schemaVersion !== 1) reject(rootSchemaMsg(raw));
  const out = {
    schemaVersion: 1,
    revision: raw.revision ?? 0,
    runtime: { ...RUNTIME_DEFAULTS },
    privacy: { ...PRIVACY_DEFAULTS },
    ui: { ...UI_DEFAULTS, providerOrder: [], cards: {} },
    providers: {},
    compatibility: structuredClone(COMPAT_DEFAULTS),
  };
  if (!Number.isInteger(out.revision) || out.revision < 0) reject("root.revision");
  if (raw.runtime !== undefined) {
    checkUnknown(raw.runtime, Object.keys(RUNTIME_DEFAULTS), "runtime");
    for (const [k, dv] of Object.entries(RUNTIME_DEFAULTS)) {
      const v = raw.runtime[k] ?? dv;
      if (k === "nodePath") {
        if (v !== "auto" && !(typeof v === "string" && v.startsWith("/"))) reject("runtime.nodePath");
      } else {
        const [lo, hi] = { refreshIntervalSeconds: [60, 86400], timeoutSeconds: [1, 30], maxConcurrency: [1, 6] }[k];
        intRange(`runtime.${k}`, v, lo, hi);
      }
      out.runtime[k] = v;
    }
  }
  if (raw.privacy !== undefined) {
    checkUnknown(raw.privacy, ["allowBrowserDiscovery", "diagnostics"], "privacy");
    if (typeof (raw.privacy.allowBrowserDiscovery ?? false) !== "boolean") reject("privacy.allowBrowserDiscovery");
    out.privacy.allowBrowserDiscovery = raw.privacy.allowBrowserDiscovery ?? false;
    if (raw.privacy.diagnostics !== undefined) enumCheck("privacy.diagnostics", raw.privacy.diagnostics, "privacy.diagnostics");
    out.privacy.diagnostics = raw.privacy.diagnostics ?? PRIVACY_DEFAULTS.diagnostics;
  }
  if (raw.ui !== undefined) {
    const rui = raw.ui;
    checkUnknown(rui, [...Object.keys(UI_DEFAULTS), ...UI_LEGACY_KEYS], "ui");
    for (const k of ["locale", "appearance", "density", "overviewMode"]) {
      if (rui[k] !== undefined) enumCheck(`ui.${k}`, rui[k], `ui.${k}`);
    }
    if (rui.menuBarMode !== undefined) enumCheck("ui.menuBarMode", rui.menuBarMode, "ui.menuBarMode");
    for (const k of ["showMenuBarPercent", "showAccountLabel"]) {
      if (rui[k] !== undefined && typeof rui[k] !== "boolean") reject(`ui.${k}`);
    }
    if (rui.selectedProvider !== undefined && rui.selectedProvider !== null && typeof rui.selectedProvider !== "string") reject("ui.selectedProvider");
    if (rui.providerOrder !== undefined) {
      if (!Array.isArray(rui.providerOrder)) reject("ui.providerOrder");
      uniqueProviderIds(rui.providerOrder, "ui.providerOrder");
    }
    if (rui.pinnedMetrics !== undefined) {
      if (!Array.isArray(rui.pinnedMetrics) || rui.pinnedMetrics.length > 2) reject("ui.pinnedMetrics");
      rui.pinnedMetrics.forEach((pin, i) => validatePin(pin, `ui.pinnedMetrics[${i}]`));
    }
    if (rui.cards !== undefined) {
      if (!isPlainObject(rui.cards)) reject("ui.cards");
      for (const [pid, card] of Object.entries(rui.cards)) {
        if (!isPlainObject(card)) reject(`ui.cards.${pid}`);
        checkUnknown(card, ["expanded", "favorite", "metricOrder", "hiddenMetricIds"], `ui.cards.${pid}`);
      }
    }
    const menuBar = migrateMenuBar(rui);
    out.ui = {
      locale: rui.locale ?? UI_DEFAULTS.locale,
      appearance: rui.appearance ?? UI_DEFAULTS.appearance,
      density: rui.density ?? UI_DEFAULTS.density,
      overviewMode: rui.overviewMode ?? UI_DEFAULTS.overviewMode,
      selectedProvider: rui.selectedProvider === undefined ? UI_DEFAULTS.selectedProvider : rui.selectedProvider,
      showMenuBarPercent: rui.showMenuBarPercent ?? UI_DEFAULTS.showMenuBarPercent,
      showAccountLabel: rui.showAccountLabel ?? UI_DEFAULTS.showAccountLabel,
      providerOrder: rui.providerOrder ?? [],
      cards: rui.cards ?? {},
      menuBarProviders: menuBar.menuBarProviders,
      menuBarLimit: menuBar.menuBarLimit,
    };
  }
  if (raw.providers !== undefined) {
    if (!isPlainObject(raw.providers)) reject("providers");
    for (const [pid, prov] of Object.entries(raw.providers)) {
      if (!ID_RE.test(pid)) reject(`providers.${pid}: 非法 id`);
      out.providers[pid] = validateProvider(prov, `providers.${pid}`);
    }
  }
  if (raw.compatibility !== undefined) {
    const rc = raw.compatibility;
    checkUnknown(rc, ["pi", "legacyCache"], "compatibility");
    if (rc.pi !== undefined) {
      checkUnknown(rc.pi, ["enabled", "agentDir"], "compatibility.pi");
      if (typeof (rc.pi.enabled ?? false) !== "boolean") reject("compatibility.pi.enabled");
      out.compatibility.pi.enabled = rc.pi.enabled ?? false;
      if (rc.pi.agentDir !== undefined) {
        if (typeof rc.pi.agentDir !== "string" || !rc.pi.agentDir.startsWith("/")) reject("compatibility.pi.agentDir");
        out.compatibility.pi.agentDir = rc.pi.agentDir;
      }
    }
    if (rc.legacyCache !== undefined) {
      checkUnknown(rc.legacyCache, ["import", "path"], "compatibility.legacyCache");
      if (rc.legacyCache.import !== undefined) enumCheck("compatibility.legacyCache.import", rc.legacyCache.import, "compatibility.legacyCache.import");
      out.compatibility.legacyCache.import = rc.legacyCache.import ?? "never";
      if (rc.legacyCache.path !== undefined) {
        if (typeof rc.legacyCache.path !== "string" || !rc.legacyCache.path.startsWith("/")) reject("compatibility.legacyCache.path");
        out.compatibility.legacyCache.path = rc.legacyCache.path;
      }
    }
  }
  return out;
}

function rootSchemaMsg(raw) {
  if (raw.schemaVersion === undefined) return "root: 缺 schemaVersion";
  return `schema-unsupported: schemaVersion=${raw.schemaVersion}`;
}

/** JSON Merge Patch 应用（contracts §4.2）：对象递归、数组整替换、null 删除。 */
export function applyMergePatch(target, patch, allowPaths) {
  function apply(t, p, path) {
    if (!isPlainObject(p)) return p;
    const out = { ...t };
    for (const [k, v] of Object.entries(p)) {
      const np = path ? `${path}.${k}` : k;
      if (!allowPaths(np)) reject(`patch: 字段 ${np} 不允许修改`);
      if (v === null) { delete out[k]; continue; }
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? apply(out[k], v, np) : structuredClone(v);
    }
    return out;
  }
  return apply(target, patch, "");
}

/** config 根字段白名单：patch 允许触达的对象（§4.2）。 */
export function patchAllowedPath(path) {
  const root = path.split(".")[0];
  return ["runtime", "privacy", "ui", "providers", "compatibility"].includes(root);
}
