/**
 * PopupFields — normalize popup field config and build formatted {label, value} rows.
 *
 * Source-neutral: the caller supplies a plain `rawRow` object of
 * { fieldName: rawValue }. For GeoJSON that is feature.properties; for Flex
 * layers it is materialized by FlexRowAccessor. All formatting is deterministic
 * (no user-supplied functions) and locale-pinned to 'en-US' for stable output.
 */

const LOCALE = 'en-US';

/**
 * Normalize a YAML/API field list into a canonical array.
 * Accepts shorthand strings ('target_id') or objects ({ name, label, ... }).
 * @param {Array<string|object>} config
 * @returns {Array<{name:string,label:string,format?:string,decimals?:number,unit?:string,valueMap?:object,fallback?:string}>}
 */
export function normalizeFields(config) {
  if (!Array.isArray(config)) return [];
  const out = [];
  for (const raw of config) {
    if (typeof raw === 'string') {
      if (!raw) continue;
      out.push({ name: raw, label: raw });
      continue;
    }
    if (!raw || typeof raw !== 'object' || !raw.name) continue;
    const field = { name: raw.name, label: raw.label ?? raw.name };
    if (raw.format !== undefined) field.format = raw.format;
    if (raw.decimals !== undefined) field.decimals = raw.decimals;
    if (raw.unit !== undefined) field.unit = raw.unit;
    if (raw.prefix !== undefined) field.prefix = raw.prefix;
    if (raw.scale !== undefined) field.scale = raw.scale;
    if (raw.keys !== undefined) field.keys = raw.keys;
    if (raw.valueMap !== undefined) field.valueMap = raw.valueMap;
    if (raw.fallback !== undefined) field.fallback = raw.fallback;
    out.push(field);
  }
  return out;
}

/**
 * Normalize a `groups` config into labeled field groups, dropping empty ones.
 * Returns null when no groups array is provided (caller falls back to flat fields).
 * @param {Array<{label?:string, fields:Array}>} groups
 * @returns {Array<{label:string|null, fields:ReturnType<typeof normalizeFields>}>|null}
 */
export function normalizeGroups(groups) {
  if (!Array.isArray(groups)) return null;
  const out = groups
    .map((g) => ({ label: g?.label ?? null, fields: normalizeFields(g?.fields) }))
    .filter((g) => g.fields.length);
  return out.length ? out : null;
}

/**
 * Build display sections from normalized groups. Each section is
 * { label, rows }; sections whose rows are all empty are dropped.
 * @param {ReturnType<typeof normalizeGroups>} groups
 * @param {object} rawRow
 * @param {{ decode?: Function }} [opts]
 * @returns {Array<{label:string|null, rows:Array<{label:string,value:string}>}>}
 */
export function buildSections(groups, rawRow, opts = {}) {
  return (groups || [])
    .map((g) => ({ label: g.label, rows: buildRows(g.fields, rawRow, opts) }))
    .filter((s) => s.rows.length);
}

/**
 * Build formatted popup rows from a raw row object.
 * @param {ReturnType<typeof normalizeFields>} fields
 * @param {object} rawRow  Map of fieldName → raw value.
 * @param {{ decode?: (fieldName:string, rawValue:*) => (string|undefined) }} [opts]
 *        `decode` resolves dictionary/enum columns to labels. valueMap wins over decode.
 * @returns {Array<{label:string, value:string}>}
 */
export function buildRows(fields, rawRow, opts = {}) {
  const decode = opts.decode;
  const rows = [];
  for (const field of fields) {
    const raw = rawRow ? rawRow[field.name] : undefined;
    const present = _isPresent(raw);

    // valueMap: explicit per-field override, highest precedence.
    if (field.valueMap) {
      if (present && Object.prototype.hasOwnProperty.call(field.valueMap, raw)) {
        rows.push({ label: field.label, value: String(field.valueMap[raw]) });
      } else if (field.fallback !== undefined) {
        rows.push({ label: field.label, value: String(field.fallback) });
      }
      continue;
    }

    if (!present) {
      if (field.fallback !== undefined) {
        rows.push({ label: field.label, value: String(field.fallback) });
      }
      continue;
    }

    // Dictionary/enum decode (from the layer), if supplied. String-shaped
    // formats (list/objectList) still apply to the decoded string.
    if (decode) {
      const decoded = decode(field.name, raw);
      if (decoded !== undefined && decoded !== null) {
        _pushValue(rows, field, _applyStringFormat(field, decoded));
        continue;
      }
    }

    _pushValue(rows, field, _format(field, raw));
  }
  return rows;
}

/** Push a formatted value as a row, omitting empty results unless a fallback exists. */
function _pushValue(rows, field, base) {
  if (base === '') {
    if (field.fallback !== undefined)
      rows.push({ label: field.label, value: String(field.fallback) });
    return;
  }
  rows.push({ label: field.label, value: _decorate(base, field.prefix, field.unit) });
}

/** Apply the string-shaped formats to an already-stringified (e.g. decoded) value. */
function _applyStringFormat(field, s) {
  if (field.format === 'list') return _list(s);
  if (field.format === 'objectList') return _objectList(s, field.keys);
  return String(s);
}

// ─── Internal ───────────────────────────────────────────────────────────────

function _isPresent(v) {
  return v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v));
}

function _decorate(value, prefix, unit) {
  let v = value;
  if (prefix) v = `${prefix}${v}`;
  if (unit) v = `${v} ${unit}`;
  return v;
}

function _format(field, raw) {
  // `scale` multiplies the raw numeric value before formatting (e.g. bps → Mbps).
  const s = field.scale;
  const scaled = s != null ? Number(raw) * s : raw;
  switch (field.format) {
    case 'string':
      return String(raw);
    case 'number':
      return _num(scaled, field.decimals);
    case 'integer':
      return _num(Math.round(Number(scaled)), 0);
    case 'percent':
      return _percent(scaled, field.decimals);
    case 'bytes':
      return _bytes(scaled);
    case 'datetime':
      return _datetime(raw);
    case 'boolean':
      return raw ? 'true' : 'false';
    case 'json':
      return JSON.stringify(raw);
    case 'list':
      return _list(raw);
    case 'objectList':
      return _objectList(raw, field.keys);
    default:
      return _auto(scaled, field.decimals);
  }
}

/** Normalize an array-ish string ("[5025, 5023]") to a clean "5025, 5023". */
function _list(raw) {
  const s = String(raw)
    .trim()
    .replace(/^\[+|\]+$/g, '')
    .trim();
  if (!s) return '';
  return s
    .split(/[,\s]+/)
    .filter(Boolean)
    .join(', ');
}

/**
 * Render a JSON array of objects as one line per object, e.g.
 *   1. ChipRate 2x · Freq 20.0 MHz
 * `keys` selects/orders/formats object properties (string or field-like object
 * with format/decimals/scale/unit/prefix). Defaults to all keys of the first
 * object. Returns '' for an empty/non-array value; the raw string on parse error.
 */
function _objectList(raw, keys) {
  let arr;
  try {
    arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return typeof raw === 'string' ? raw : '';
  }
  if (!Array.isArray(arr) || arr.length === 0) return '';

  const defs = _normalizeKeyDefs(keys, arr[0]);
  const lines = [];
  for (let i = 0; i < arr.length; i++) {
    const obj = arr[i] || {};
    const parts = [];
    for (const kd of defs) {
      const v = obj[kd.key];
      if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) continue;
      parts.push(`${kd.label} ${_decorate(_format(kd, v), kd.prefix, kd.unit)}`);
    }
    lines.push(`${i + 1}. ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}

function _normalizeKeyDefs(keys, sample) {
  if (Array.isArray(keys) && keys.length) {
    return keys.map((k) =>
      typeof k === 'string'
        ? { key: k, label: k }
        : {
            key: k.key,
            label: k.label ?? k.key,
            format: k.format,
            decimals: k.decimals,
            scale: k.scale,
            unit: k.unit,
            prefix: k.prefix,
          }
    );
  }
  if (sample && typeof sample === 'object') {
    return Object.keys(sample).map((k) => ({ key: k, label: k }));
  }
  return [];
}

function _auto(raw, decimals) {
  if (typeof raw === 'number') return _num(raw, decimals);
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw === 'object') return JSON.stringify(raw);
  return String(raw);
}

function _num(v, decimals) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (decimals != null) {
    return n.toLocaleString(LOCALE, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }
  return n.toLocaleString(LOCALE);
}

function _percent(v, decimals) {
  const n = Number(v) * 100;
  const d = decimals != null ? decimals : 1;
  return `${n.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
}

function _bytes(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = n / 1024;
  let u = 0;
  while (size >= 1024 && u < units.length - 1) {
    size /= 1024;
    u++;
  }
  return `${parseFloat(size.toFixed(2))} ${units[u]}`;
}

function _datetime(v) {
  if (typeof v === 'number') return new Date(v).toISOString();
  return String(v);
}
