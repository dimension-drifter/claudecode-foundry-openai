/**
 * Keep a JSON Schema subset Chat Completions accepts for function parameters.
 * The Azure REST reference types parameters as a JSON Schema object and does
 * not list every rejected keyword, so this is an allowlist.
 */

const ALLOWED = new Set([
    'type',
    'description',
    'properties',
    'required',
    'items',
    'enum',
    'additionalProperties',
    'title'
]);

/**
 * @param {unknown} schema
 * @returns {object}
 */
export function sanitizeSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return { type: 'object', properties: {} };
    }
    return sanitizeNode(schema);
}

/**
 * @param {object} schema
 * @returns {object}
 */
function sanitizeNode(schema) {
    if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
    if (Array.isArray(schema)) {
        return sanitizeNode(schema[0] || { type: 'string' });
    }

    const out = {};
    if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
        out.enum = [schema.const];
    }

    for (const [key, value] of Object.entries(schema)) {
        if (key === 'const' || !ALLOWED.has(key)) continue;

        if (key === 'type') {
            if (Array.isArray(value)) {
                const nonNull = value.filter((item) => item !== 'null' && typeof item === 'string');
                out.type = nonNull[0] || 'string';
            } else if (typeof value === 'string') {
                out.type = value;
            }
            continue;
        }

        if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
            const properties = {};
            for (const [propName, propSchema] of Object.entries(value)) {
                properties[propName] = sanitizeNode(propSchema);
            }
            out.properties = properties;
            continue;
        }

        if (key === 'items') {
            const itemSchema = Array.isArray(value) ? (value[0] || { type: 'string' }) : value;
            out.items = sanitizeNode(itemSchema);
            continue;
        }

        if (key === 'required' && Array.isArray(value)) {
            const required = value.filter((item) => typeof item === 'string');
            if (required.length > 0) out.required = required;
            continue;
        }

        if (key === 'enum' && Array.isArray(value)) {
            out.enum = value;
            continue;
        }

        if (key === 'additionalProperties' && typeof value === 'boolean') {
            out.additionalProperties = value;
            continue;
        }

        if ((key === 'description' || key === 'title') && typeof value === 'string') {
            out[key] = value;
        }
    }

    if (!out.type && out.properties) out.type = 'object';
    else if (!out.type && out.items) out.type = 'array';
    else if (!out.type && !out.enum) out.type = 'object';
    return out;
}
