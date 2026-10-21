/**
 * 极简 JSON Schema 校验器（覆盖 contracts 所用子集：
 * type object/array/string/integer/number/boolean、properties、required、
 * minimum、maximum、minLength、maxLength、enum、items、minItems/maxItems、oneOf）。
 * 仅用于 Broker 下发前校验；插件侧 protocol.ts 只校验 sync.request 的 requestId/action，
 * 不做 inputSchema 校验（业务校验由各 action 自己完成）。
 */

function isInteger(value) {
    return Number.isInteger(value);
}

function checkType(type, value) {
    switch (type) {
        case "object":
            return typeof value === "object" && value !== null && !Array.isArray(value);
        case "array":
            return Array.isArray(value);
        case "string":
            return typeof value === "string";
        case "integer":
            return isInteger(value);
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "boolean":
            return typeof value === "boolean";
        default:
            return false;
    }
}

/**
 * @returns {string|null} 错误信息；null 表示通过
 */
export function validateAgainstSchema(schema, value, path = "") {
    if (!schema || typeof schema !== "object") return null;
    const label = path || "参数";

    // oneOf：恰好一个 subschema 通过才合法（0 个/多个都拒绝，且错误信息可区分两种成因）
    if (Array.isArray(schema.oneOf)) {
        let matches = 0;
        let firstError = null;
        for (const sub of schema.oneOf) {
            const subError = validateAgainstSchema(sub, value, path);
            if (subError === null) matches += 1;
            else if (firstError === null) firstError = subError;
        }
        if (matches === 0) {
            return `${label} 必须满足以下组合之一（二选一）${firstError ? `：${firstError}` : ""}`;
        }
        if (matches > 1) {
            return `${label} 只能满足以下一种组合（只能二选一），当前同时满足 ${matches} 种`;
        }
    }

    if (Array.isArray(schema.type)) {
        if (!schema.type.some((t) => checkType(t, value))) {
            return `${label} 类型必须是 ${schema.type.join("|")}`;
        }
    } else if (schema.type && !checkType(schema.type, value)) {
        if (schema.type === "integer" && typeof value === "number" && Number.isFinite(value)) {
            return `${label} 必须是整数`;
        }
        return `${label} 类型必须是 ${schema.type}`;
    }
    if (schema.enum && !schema.enum.includes(value)) {
        return `${label} 必须是 ${schema.enum.join(" / ")}`;
    }
    if (typeof value === "string") {
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            return `${label} 长度不得少于 ${schema.minLength}`;
        }
        if (schema.maxLength !== undefined && value.length > schema.maxLength) {
            return `${label} 长度不得超过 ${schema.maxLength}`;
        }
    }
    if (typeof value === "number") {
        if (schema.minimum !== undefined && value < schema.minimum) {
            return `${label} 不得小于 ${schema.minimum}`;
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            return `${label} 不得大于 ${schema.maximum}`;
        }
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            return `${label} 至少需要 ${schema.minItems} 个元素`;
        }
        if (schema.maxItems !== undefined && value.length > schema.maxItems) {
            return `${label} 最多允许 ${schema.maxItems} 个元素`;
        }
        if (schema.items) {
            for (let i = 0; i < value.length; i += 1) {
                const err = validateAgainstSchema(schema.items, value[i], `${path}[${i}]`);
                if (err) return err;
            }
        }
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const key of schema.required ?? []) {
            if (!(key in value)) return `缺少必填参数: ${path ? `${path}.${key}` : key}`;
        }
        for (const [key, sub] of Object.entries(schema.properties ?? {})) {
            if (key in value) {
                const err = validateAgainstSchema(sub, value[key], path ? `${path}.${key}` : key);
                if (err) return err;
            }
        }
    }
    return null;
}
