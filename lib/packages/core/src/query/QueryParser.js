/**
 * QueryParser.js — Parse simple filter expressions into GPU-ready predicates.
 *
 * Syntax:
 *   served_mbps > 50
 *   served_mbps 100..500
 *   custom_region = CONUS
 *   served_mbps > 50 AND custom_region = CONUS
 *   served_mbps > 200 OR served_mbps < 10
 *
 * Returns an array of predicate groups for AND/OR evaluation.
 */

// Operator enum (matches shader u_filterOp)
export const FilterOp = {
  NONE: 0,
  EQ: 1,
  GT: 2,
  LT: 3,
  GTE: 4,
  LTE: 5,
  BETWEEN: 6,
};

/**
 * @typedef {Object} FilterPredicate
 * @property {string} column    - Column name to filter on
 * @property {number} op        - FilterOp enum value
 * @property {number} value     - Threshold value (or low bound for BETWEEN)
 * @property {number} [high]    - Upper bound for BETWEEN
 * @property {boolean} isEnum   - Whether the value is a dictionary lookup
 * @property {string} [rawValue] - Original string value (for enum display)
 */

/**
 * @typedef {Object} FilterSpec
 * @property {FilterPredicate[][]} groups   - OR-separated groups of AND predicates
 * @property {string} raw                   - Original query string
 */

/**
 * Parse a query string into a FilterSpec.
 *
 * Grammar (informal):
 *   query     = group ( "OR" group )*
 *   group     = predicate ( "AND" predicate )*
 *   predicate = column operator value
 *   operator  = "=" | ">" | "<" | ">=" | "<="
 *   predicate = column value ".." value      (between shorthand)
 *
 * @param {string} queryStr - User input
 * @param {Object} schema   - { staticColumns: {}, temporalColumns: {}, dictionary: [] }
 * @returns {FilterSpec|null} Parsed filter spec, or null if empty/invalid
 */
export function parseQuery(queryStr, schema) {
  const raw = (queryStr || '').trim();
  if (!raw) return null;

  // Split on OR (case-insensitive, word boundary)
  const orParts = raw
    .split(/\bOR\b/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const groups = [];
  for (const orPart of orParts) {
    // Split on AND within each OR group
    const andParts = orPart
      .split(/\bAND\b/i)
      .map((s) => s.trim())
      .filter(Boolean);
    const predicates = [];

    for (const part of andParts) {
      const pred = _parsePredicate(part, schema);
      if (!pred) continue; // incomplete or invalid predicate — skip
      predicates.push(pred);
    }

    if (predicates.length > 0) {
      groups.push(predicates);
    }
  }

  return groups.length > 0 ? { groups, raw } : null;
}

/**
 * Parse a single predicate: "column op value" or "column low..high"
 * @private
 */
function _parsePredicate(expr, schema) {
  // Try BETWEEN shorthand: column low..high
  const betweenMatch = expr.match(/^(\w+)\s+([\d.]+)\s*\.\.\s*([\d.]+)$/);
  if (betweenMatch) {
    const [, column, lowStr, highStr] = betweenMatch;
    return _buildPredicate(
      column,
      FilterOp.BETWEEN,
      parseFloat(lowStr),
      schema,
      parseFloat(highStr)
    );
  }

  // Try comparison: column op value
  const compMatch = expr.match(/^(\w+)\s*(>=|<=|>|<|=)\s*(.+)$/);
  if (compMatch) {
    const [, column, opStr, valueStr] = compMatch;
    const op = _parseOp(opStr);
    return _buildPredicate(column, op, valueStr.trim(), schema);
  }

  // Incomplete predicate (e.g. "airline =" while still typing) — silently skip
  const incompleteMatch = expr.match(/^(\w+)\s*(>=|<=|>|<|=)?\s*$/);
  if (incompleteMatch) {
    return null; // Still typing — not an error
  }

  console.warn(`[QueryParser] Cannot parse predicate: "${expr}"`);
  return null;
}

/**
 * Build a predicate, resolving enum values via the dictionary.
 * @private
 */
function _buildPredicate(column, op, value, schema, high) {
  const allColumns = { ...schema.staticColumns, ...schema.temporalColumns };

  // Check if column exists in schema
  if (!allColumns[column] && !_isKnownColumn(column, schema)) {
    console.warn(`[QueryParser] Unknown column: "${column}"`);
    return null;
  }

  // Check if this is an enum column (dictionary-based)
  const isEnum = _isEnumColumn(column, schema);

  let numValue;
  if (isEnum && typeof value === 'string' && isNaN(value)) {
    // Look up string in dictionary
    const dict = schema.dictionary || [];
    const idx = dict.indexOf(value);
    if (idx === -1) {
      console.warn(`[QueryParser] Unknown dictionary value: "${value}" for column "${column}"`);
      return null;
    }
    numValue = idx;
  } else {
    numValue = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(numValue)) {
      console.warn(`[QueryParser] Invalid numeric value: "${value}" for column "${column}"`);
      return null;
    }
  }

  const pred = {
    column,
    op,
    value: numValue,
    isEnum,
  };

  if (op === FilterOp.BETWEEN) {
    pred.high = typeof high === 'number' ? high : parseFloat(high);
  }

  if (isEnum && typeof value === 'string') {
    pred.rawValue = value;
  }

  return pred;
}

/**
 * Check if a column name exists in the schema (static, temporal, or schema list).
 * @private
 */
function _isKnownColumn(column, schema) {
  if (schema.schemaList) {
    return schema.schemaList.some((s) => s.name === column);
  }
  return false;
}

/**
 * Check if a column is an ENUM16 type.
 * @private
 */
function _isEnumColumn(column, schema) {
  if (schema.schemaList) {
    const entry = schema.schemaList.find((s) => s.name === column);
    if (entry)
      return (
        entry.type === 6 ||
        entry.type === 8 ||
        entry.type === 9 ||
        entry.type === 14 ||
        String(entry.type).includes('enum')
      ); // ENUM8/16/32
  }
  // Fallback: check if data is Uint16Array
  const data = schema.staticColumns?.[column] || schema.temporalColumns?.[column];
  if (data && data.constructor === Uint16Array) return true;
  return false;
}

function _parseOp(opStr) {
  switch (opStr) {
    case '=':
      return FilterOp.EQ;
    case '>':
      return FilterOp.GT;
    case '<':
      return FilterOp.LT;
    case '>=':
      return FilterOp.GTE;
    case '<=':
      return FilterOp.LTE;
    default:
      return FilterOp.NONE;
  }
}

/**
 * Compile a FilterSpec into a JS predicate for CPU-side picking.
 * Returns a function that accepts a GeoJSON properties object and returns
 * true if the feature passes the filter (i.e. is visible).
 *
 * @param {FilterSpec} spec
 * @returns {(properties: object) => boolean}
 */
export function flattenForCPU(spec) {
  if (!spec?.groups?.length) return () => true;
  const groups = spec.groups;
  return function cpuFilter(props) {
    for (const group of groups) {
      // OR across groups
      let groupPass = true;
      for (const pred of group) {
        // AND within group
        const raw = props[pred.column];
        if (raw == null) {
          groupPass = false;
          break;
        }
        const v = Number(raw);
        const t = pred.value;
        let pass;
        switch (pred.op) {
          case FilterOp.EQ:
            pass = v === t;
            break;
          case FilterOp.GT:
            pass = v > t;
            break;
          case FilterOp.LT:
            pass = v < t;
            break;
          case FilterOp.GTE:
            pass = v >= t;
            break;
          case FilterOp.LTE:
            pass = v <= t;
            break;
          case FilterOp.BETWEEN:
            pass = v >= t && v <= pred.high;
            break;
          default:
            pass = true;
        }
        if (!pass) {
          groupPass = false;
          break;
        }
      }
      if (groupPass) return true;
    }
    return false;
  };
}

/**
 * Flatten a FilterSpec into at most 2 predicates for the shader.
 * For simple AND queries: returns both predicates with combinator AND.
 * For OR queries: GPU handles OR via multi-pass or flat predicate list.
 *
 * @param {FilterSpec} spec
 * @returns {{ predicates: FilterPredicate[], combinator: 'AND'|'OR' }|null}
 */
export function flattenForGPU(spec) {
  if (!spec || spec.groups.length === 0) return null;

  if (spec.groups.length === 1) {
    // Single AND group — take up to 2 predicates
    return {
      predicates: spec.groups[0].slice(0, 2),
      combinator: 'AND',
    };
  }

  // Multiple OR groups — flatten to first predicate of each (up to 2)
  // For full OR support, each OR group becomes a predicate
  const preds = spec.groups.slice(0, 2).map((g) => g[0]);
  return {
    predicates: preds,
    combinator: 'OR',
  };
}
