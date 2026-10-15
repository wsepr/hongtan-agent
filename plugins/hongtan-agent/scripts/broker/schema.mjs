/**
 * 极简 JSON Schema 校验器（覆盖 contracts 所用子集：
 * type object/string/integer/number/boolean、properties、required、
 * minimum、maximum、minLength、maxLength、enum）。
 * 仅用于 Broker 下发前校验，插件侧二次校验（双端，设计文档 §7.6）。
 */

function isInteger(value) {
    return Number.isInteger(value);
}

function checkType(type, value) {
    switch (type) {
        case "object":
            return typeof value === "object" && value !== null && !Array.isArray(value);
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
    if (Array.isArray(schema.type)) {
        if (!schema.type.some((t) => checkType(t, value))) {
            return `${path || "参数"} 类型必须是 ${schema.type.join("|")}`;
        }
    } else if (schema.type && !checkType(schema.type, value)) {
        const label = path || "参数";
        if (schema.type === "integer" && typeof value === "number" && Number.isFinite(value)) {
            return `${label} 必须是整数`;
        }
        return `${label} 类型必须是 ${schema.type}`;
    }
    if (schema.enum && !schema.enum.includes(value)) {
        return `${path || "参数"} 必须是 ${schema.enum.join(" / ")}`;
    }
    if (typeof value === "string") {
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            return `${path || "参数"} 长度不得少于 ${schema.minLength}`;
        }
        if (schema.maxLength !== undefined && value.length > schema.maxLength) {
            return `${path || "参数"} 长度不得超过 ${schema.maxLength}`;
        }
    }
    if (typeof value === "number") {
        if (schema.minimum !== undefined && value < schema.minimum) {
            return `${path || "参数"} 不得小于 ${schema.minimum}`;
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            return `${path || "参数"} 不得大于 ${schema.maximum}`;
        }
    }
    if (schema.type === "object" && typeof value === "object" && value !== null) {
        for (const key of schema.required ?? []) {
            if (!(key in value)) return `缺少必填参数: ${key}`;
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
